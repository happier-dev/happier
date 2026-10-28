import { writeAcpTestAgentScript } from './subprocessHarness';

// Wire vector: FX 0.0.14 (1a070af32cdf), captured 2026-10-27 in
// 0.3/.project/tmp/vercel-meeting/E-fx-live-probe.md §3. No legacy models field.
export function createFx014SessionResponse() {
  return {
    sessionId: 'fx-fixture-session',
    configOptions: [
      { id: 'provider', name: 'Provider', category: 'model', type: 'select', currentValue: 'codex', options: [
        { value: 'gateway', name: 'Vercel AI Gateway' }, { value: 'codex', name: 'Codex subscription' },
        { value: 'grok', name: 'Grok subscription' },
      ] },
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-6.1-sol', options: [
        'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna',
        'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
      ].map((value) => ({ value, name: value })) },
      { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'auto', options: [
        { value: 'auto', name: 'Auto' }, { value: 'ask', name: 'Ask' }, { value: 'full-access', name: 'Full access' },
      ] },
      { id: 'effort', name: 'Reasoning Effort', category: 'thought_level', type: 'select', currentValue: 'auto', options: [
        { value: 'auto', name: 'default' },
        ...['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((value) => ({ value, name: value })),
      ] },
      { id: 'fast', name: 'Fast Mode', category: 'model', type: 'select', currentValue: 'false', options: [
        { value: 'false', name: 'off' }, { value: 'true', name: 'on' },
      ] },
    ],
    modes: { currentModeId: 'auto', availableModes: [
      { id: 'auto', name: 'Auto', description: 'Check actions with an automatic safety review instead of asking' },
      { id: 'ask', name: 'Ask', description: 'Request permission before making any changes' },
      { id: 'full-access', name: 'Full access', description: 'Run every action without asking, outside the sandbox' },
    ] },
  };
}

/** External ACP process boundary: full setter responses, no config notifications. */
export function writeFx014AcpAgentScript(params: {
  dir: string;
  configOptions?: ReadonlyArray<unknown>;
  modeIds?: ReadonlyArray<string>;
}): string {
  const response = createFx014SessionResponse();
  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fx014-acp-agent.mjs',
    source: `
      import { createInterface } from 'node:readline';
      const response = ${JSON.stringify(response)};
      response.configOptions = ${JSON.stringify(params.configOptions ?? response.configOptions)};
      const modeIds = ${JSON.stringify(params.modeIds ?? response.modes.availableModes.map((mode) => mode.id))};
      response.modes = { currentModeId: modeIds[0], availableModes: modeIds.map(id => ({id, name: id})) };
      const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id, result})+'\\n');
      const fail = (id, code, message) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id, error:{code, message}})+'\\n');
      for await (const line of createInterface({input:process.stdin})) {
        const {id, method, params = {}} = JSON.parse(line);
        if (id == null) continue;
        if (method === 'initialize') send(id, {protocolVersion:1, authMethods:[], agentCapabilities:{loadSession:true}});
        else if (method === 'session/new' || method === 'session/load') send(id, response);
        else if (method === 'session/set_mode') {
          if (!modeIds.includes(params.modeId)) fail(id, -32602, 'Unknown mode');
          else { response.modes.currentModeId = params.modeId; send(id, {}); }
        } else if (method === 'session/set_config_option') {
          if (params.configId === 'provider' && params.value === 'gateway') {
            fail(id, -32600, 'fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.');
            continue;
          }
          response.configOptions = response.configOptions.map(option => {
            if (option.id === params.configId) return {...option, currentValue:params.value};
            if (params.configId === 'model' && params.value === 'gpt-6-luna' && option.id === 'effort')
              return {...option, options:option.options.filter(choice => choice.value !== 'ultra')};
            return option;
          });
          send(id, {configOptions:response.configOptions});
        } else send(id, {});
      }
    `,
  });
}
