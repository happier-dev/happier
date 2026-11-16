import { createRequire } from 'node:module';

import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';

/** Native CLI/process boundary shared by selected-account launch and public inventory. */
export function writeKimiNativeProcessFixture(directory: string, route: string, capture: string) {
  const script = writeAcpTestAgentScript({ dir: directory, fileName: `${route}-agent.mjs`, source: `
    import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { createRequire } from 'node:module';
    import { createInterface } from 'node:readline';
    if (process.argv.includes('migrate')) { process.stdout.write('Usage: kimi migrate'); process.exit(0); }
    const { parse } = createRequire(import.meta.url)(${JSON.stringify(createRequire(import.meta.url).resolve('smol-toml'))});
    const home = process.env.KIMI_CODE_HOME;
    const config = home && existsSync(join(home, 'config.toml')) ? readFileSync(join(home, 'config.toml'), 'utf8') : '';
    const parsed = config ? parse(config) : { models: {}, default_model: 'unselected' };
    const modelIds = Object.keys(parsed.models);
    let currentModelId = parsed.default_model;
    const configOptions = () => [{ id: 'model', name: 'Model', category: 'model', type: 'select',
      currentValue: currentModelId, options: modelIds.map(value => ({ value, name: value })) }];
    const captured = {
      home, accessToken: process.env.HAPPIER_KIMI_ACCESS_TOKEN,
      inheritedKey: process.env.KIMI_API_KEY, config,
      credentialsExist: home ? existsSync(join(home, 'credentials')) : false, requests: [],
    };
    const save = () => writeFileSync(${JSON.stringify(capture)}, JSON.stringify(captured));
    save();
    let sessionId = 'factory-${route}';
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      if (request.id === undefined) continue;
      captured.requests.push({ method: request.method, currentModelId }); save();
      let result = {};
      if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {
        loadSession: true, mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {}, fork: {} },
      } };
      if (request.method === 'session/new' || request.method === 'session/load') {
        if (!process.env.HAPPIER_KIMI_ACCESS_TOKEN) {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
            error: { code: -32000, message: 'Authentication required' } }) + '\\n');
          continue;
        }
        sessionId = request.method === 'session/load' ? request.params.sessionId : sessionId;
        const sessionDir = join(home, 'sessions', 'wd_fixture', sessionId);
        mkdirSync(join(sessionDir, 'agents', 'main'), { recursive: true });
        writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({ sessionId }));
        writeFileSync(join(sessionDir, 'agents', 'main', 'wire.jsonl'), JSON.stringify({ type: 'metadata', protocol_version: '1.5' }) + '\\n');
        if (request.method === 'session/new') appendFileSync(join(home, 'session_index.jsonl'),
          JSON.stringify({ sessionId, sessionDir, workDir: request.params.cwd }) + '\\n');
        result = { ...(request.method === 'session/new' ? { sessionId } : {}), models: {
          currentModelId, availableModels: modelIds.map(modelId => ({ modelId, name: modelId })),
        }, configOptions: configOptions(), modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } };
      }
      if (request.method === 'session/set_config_option') {
        if (request.params.configId !== 'model' || !modelIds.includes(request.params.value)) throw new Error('Requested model is outside the selected catalog');
        currentModelId = request.params.value;
        result = { configOptions: configOptions() };
      }
      if (request.method === 'session/prompt') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NATIVE_SELECTED_COMPLETE' } },
        } }) + '\\n');
        result = { stopReason: 'end_turn' };
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    }
  ` });
  return script;
}
