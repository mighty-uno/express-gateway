let mock = require('mock-require');
mock('redis', require('fakeredis'));

let session = require('supertest-session');
let should = require('should');
let qs = require('querystring');
let url = require('url');
let express = require('express');
let sinon = require('sinon');
let assert = require('assert');

let logger = require('../../lib/policies/log/winston-logger');
let credentialModelConfig = require('../../lib/config/models/credentials');
let userModelConfig = require('../../lib/config/models/users');
let appModelConfig = require('../../lib/config/models/applications');
let services = require('../../lib/services');
let credentialService = services.credential;
let userService = services.user;
let applicationService = services.application;
let db = require('../../lib/db')();

let testHelper = require('../common/routing.helper');
let config = require('../../lib/config');
let originalGatewayConfig = config.gatewayConfig;

describe('End to End tests with oauth2, proxy, log, expression, rate-limit policies', () => {
  let helper = testHelper();
  let spy = sinon.spy();
  let originalAppConfig, originalCredentialConfig, originalUserConfig;
  let user, application, token, app, backendServer;

  before('setup', (done) => {
    sinon.spy(logger, 'info');

    config.gatewayConfig = {
      http: { port: 9089 },
      serviceEndpoints: {
        backend: {
          url: 'http://localhost:7777'
        }
      },
      apiEndpoints: {
        authorizedEndpoint: {
          host: '*',
          paths: ['/authorizedPath'],
          scopes: [ 'authorizedScope' ]
        }
      },
      policies: ['oauth2', 'proxy', 'log', 'expression', 'rate-limit'],
      pipelines: {
        pipeline1: {
          apiEndpoints: ['authorizedEndpoint'],
          policies: [
            { oauth2: null },
            {
              expression: {
                action: {
                  jscode: 'req.url = req.url + "/67"'
                }
              }
            },
            {
              log: [
                {
                  action: {
                    // eslint-disable-next-line no-template-curly-in-string
                    message: '${req.url} ${egContext.req.method}'
                  }
                },
                {
                  condition: {
                    name: 'never'
                  },
                  action: {
                    // eslint-disable-next-line no-template-curly-in-string
                    message: '${req.url} ${egContext.req.method}'
                  }
                }
              ]
            },
            {
              'rate-limit': {
                action: {
                  max: 1,
                  // eslint-disable-next-line no-template-curly-in-string
                  rateLimitBy: '${req.host}'
                }
              }
            },
            {
              proxy: {
                action: { serviceEndpoint: 'backend' }
              }
            }
          ]
        }
      }
    };

    originalAppConfig = appModelConfig;
    originalCredentialConfig = credentialModelConfig;
    originalUserConfig = userModelConfig;

    appModelConfig.properties = {
      name: { isRequired: true, isMutable: true },
      redirectUri: { isRequired: true, isMutable: true }
    };

    credentialModelConfig.oauth = {
      passwordKey: 'secret',
      properties: { scopes: { isRequired: false } }
    };

    userModelConfig.properties = {
      firstname: {isRequired: true, isMutable: true},
      lastname: {isRequired: true, isMutable: true},
      email: {isRequired: false, isMutable: true}
    };

    db.flushdbAsync()
      .then(function () {
        let user1 = {
          username: 'irfanbaqui',
          firstname: 'irfan',
          lastname: 'baqui',
          email: 'irfan@eg.com'
        };

        userService.insert(user1)
          .then(_user => {
            should.exist(_user);
            user = _user;

            let app1 = {
              name: 'irfan_app',
              redirectUri: 'https://some.host.com/some/route'
            };

            applicationService.insert(app1, user.id)
              .then(_app => {
                should.exist(_app);
                application = _app;

                return credentialService.insertScopes(['authorizedScope'])
                  .then(() => {
                    Promise.all([ credentialService.insertCredential(application.id, 'oauth', { secret: 'app-secret', scopes: ['authorizedScope'] }),
                      credentialService.insertCredential(user.username, 'basic-auth', { password: 'password', scopes: ['authorizedScope'] }) ])
                      .then(res => {
                        should.exist(res);

                        helper.setup()
                          .then(apps => {
                            app = apps.app;
                            let request = session(app);

                            request
                              .post('/login')
                              .query({
                                username: user.username,
                                password: 'password'
                              })
                              .expect(302)
                              .end(function (err, res) {
                                should.not.exist(err);

                                request
                                  .get('/oauth2/authorize')
                                  .query({
                                    redirect_uri: application.redirectUri,
                                    response_type: 'token',
                                    client_id: application.id,
                                    scope: 'authorizedScope'
                                  })
                                  .expect(200)
                                  .end(function (err, res) {
                                    should.not.exist(err);

                                    request
                                      .post('/oauth2/authorize/decision')
                                      .query({
                                        transaction_id: res.headers.transaction_id
                                      })
                                      .expect(302)
                                      .end(function (err, res) {
                                        should.not.exist(err);
                                        let params = qs.parse(url.parse(res.headers.location).hash.slice(1));
                                        token = params.access_token;

                                        let backendApp = express();
                                        backendApp.all('*', (req, res) => {
                                          spy(req.headers);
                                          res.send();
                                        });

                                        let runningBackendApp = backendApp.listen(7777, () => {
                                          backendServer = runningBackendApp;
                                          done();
                                        });
                                      });
                                  });
                              });
                          });
                      });
                  });
              });
          });
      })
      .catch(function (err) {
        should.not.exist(err);
        done();
      });
  });

  after('cleanup', (done) => {
    helper.cleanup();
    config.gatewayConfig = originalGatewayConfig;
    appModelConfig.properties = originalAppConfig.properties;
    credentialModelConfig.oauth = originalCredentialConfig.oauth;
    userModelConfig.properties = originalUserConfig.properties;
    logger.info.restore();
    backendServer.close();
    done();
  });

  it('should execute oauth2, proxy, log, expression, rate-limit policies and return 200', function (done) {
    let request = session(app);

    request
      .get('/authorizedPath')
      .set('Authorization', 'bearer ' + token)
      .expect(200)
      .end(function (err) {
        should.not.exist(err);
        assert(spy.calledOnce);
        assert.equal(logger.info.getCall(0).args[0], '/authorizedPath/67 GET');
        should.not.exist(logger.info.getCall(1));
        done();
      });
  });

  it('should execute oauth2, proxy, log, expression, rate-limit policies and return 429 as rate limit is reached', function (done) {
    let request = session(app);

    request
      .get('/authorizedPath')
      .set('Authorization', 'bearer ' + token)
      .expect(429)
      .end(function (err) {
        should.not.exist(err);
        assert(spy.calledOnce);
        assert.equal(logger.info.getCall(1).args[0], '/authorizedPath/67 GET');
        done();
      });
  });
});
