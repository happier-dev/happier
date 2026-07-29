/**
 * Test-only adapter for stateful fake agents implemented as plain method objects.
 * The public AgentApp owns transport and dispatch so individual E2E fixtures do
 * not depend on deprecated connection wrappers or package-internal entry points.
 */
export function connectAcpTestAgentApp({ acp, stream, createAgent, name = 'happier-e2e-test-agent' }) {
  let implementation = null;
  const current = () => {
    if (!implementation) throw new Error('ACP test agent connection has not opened');
    return implementation;
  };
  const invoke = async (method, params) => {
    const fn = current()[method];
    if (typeof fn !== 'function') throw acp.RequestError.methodNotFound(method);
    return await fn.call(current(), params);
  };

  const objectParams = { parse: (value) => value };
  const app = acp.agent({ name })
    .onConnect(({ client }) => {
      implementation = createAgent({
        sessionUpdate: (params) => client.notify('session/update', params),
        requestPermission: (params) => client.request('session/request_permission', params),
        readTextFile: (params) => client.request('fs/read_text_file', params),
        writeTextFile: (params) => client.request('fs/write_text_file', params),
      });
    })
    .onRequest('initialize', ({ params }) => invoke('initialize', params))
    .onRequest('authenticate', ({ params }) => invoke('authenticate', params))
    .onRequest('session/new', ({ params }) => invoke('newSession', params))
    .onRequest('session/load', ({ params }) => invoke('loadSession', params))
    .onRequest('session/fork', ({ params }) => invoke('forkSession', params))
    .onRequest('session/prompt', ({ params }) => invoke('prompt', params))
    .onRequest('session/set_mode', ({ params }) => invoke('setSessionMode', params))
    .onRequest('session/set_config_option', ({ params }) => invoke('setSessionConfigOption', params))
    .onRequest('session/set_model', objectParams, ({ params }) => invoke('setSessionModel', params))
    .onNotification('session/cancel', ({ params }) => invoke('cancel', params).then(() => {}));

  return app.connect(stream);
}
