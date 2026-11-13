import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecService, PluginProcessHandle, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { getVoiceActionFunctionTool } from '@happier-dev/protocol/voice/actions';

import { createCodexAgentRuntime } from '../engine.js';
import { admitTestExecSpawn, prepareTestNativeSocketDirectory } from './client.test-support';
import { connectManagedJsonRpcTestClient } from '../../../../../../../apps/cli/src/testkit/process/managedJsonRpc';
import { buildLocalVoiceAgentSystemPrompt } from '../../../../../../agents/src/voice/voiceAgentPrompt';

const nativeBinary = process.env.HAPPIER_CODEX_NATIVE_TEST_BIN;
type ModelRequest = { input?: { role?: string; content?: { text?: string }[] }[]; tools?: unknown[] };

// Opt-in native/HTTP boundary probe: no provider credentials, user Home or remote model.
describe.skipIf(!nativeBinary || process.platform === 'win32')('real native Codex Voice prompt cost', () => {
  it('excludes repository instructions and the skill catalog while retaining the Voice prompt and function', async ({ onTestFinished }) => {
    const root = await mkdtemp('/tmp/happier-voice-cost-');
    const home = join(root, 'home');
    const codexHome = join(root, 'codex');
    const workspace = join(root, 'workspace');
    await Promise.all([home, codexHome, workspace].map(path => mkdir(path)));
    await writeFile(join(workspace, 'AGENTS.md'), 'VOICE_COST_REPOSITORY_INSTRUCTION\n');
    for (let i = 0; i < 46; i++) {
      const skill = join(workspace, '.agents', 'skills', `fixture-${i}`);
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, 'SKILL.md'), `---\nname: fixture-${i}\ndescription: VOICE_COST_SKILL_${i} instruction catalog fixture\n---\nOffline fixture.\n`);
    }
    const requests: ModelRequest[] = [];
    const deniedExternalHosts: string[] = [];
    const model = createServer(async (request, response) => {
      if (request.url?.startsWith('http:') || request.url?.startsWith('https:')) {
        deniedExternalHosts.push(request.headers.host ?? 'unknown');
        response.writeHead(403).end(); return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      // The only model peer is this loopback HTTP fixture.
      requests.push(JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest);
      const message = { id: `message-${requests.length}`, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Ready.', annotations: [] }] };
      const result = { id: `response-${requests.length}`, object: 'response', status: 'completed', output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: message },
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response: result },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    model.on('connect', (request, socket) => {
      deniedExternalHosts.push(request.url ?? 'unknown');
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    model.listen(0, '127.0.0.1'); await once(model, 'listening');
    const address = model.address();
    if (!address || typeof address === 'string') throw new Error('Loopback model unavailable');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const env = { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome, TMPDIR: root,
      HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint,
      http_proxy: endpoint, https_proxy: endpoint, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
      OTEL_SDK_DISABLED: 'true' };
    const children: PluginProcessHandle[] = [];
    // Substitute only Exec's native-process adapter; factory, config and RPC stay real.
    const launch = (args: readonly string[]): PluginProcessHandle => {
      const child = spawn(nativeBinary!, [...args], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      child.stdout.on('data', (data: Buffer) => stdout.push(data));
      child.stderr.on('data', (data: Buffer) => stderr.push(data));
      const termination = once(child, 'exit').then(([code, signal]): PluginProcessResult['termination'] => ({
        requestedBy: { kind: 'none' }, observed: signal ? { kind: 'signal', signal } : { kind: 'exit', exitCode: code ?? 1 },
      }));
      const result = once(child, 'close').then(async (): Promise<PluginProcessResult> => ({
        stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), stdoutTruncated: false, stderrTruncated: false,
        termination: await termination,
      }));
      const handle: PluginProcessHandle = {
        write: async data => { child.stdin.write(data); }, closeStdin: async () => { child.stdin.end(); },
        onOutput: () => ({ dispose() {} }), waitForExit: () => termination, wait: () => result,
        dispose: async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await result; },
      };
      children.push(handle); return handle;
    };
    const exec = {
      withSpawnAdmission: admitTestExecSpawn, prepareNativeSocketDirectory: prepareTestNativeSocketDirectory,
      systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' }, executablePath: nativeBinary }) },
      run: async (request: { args: readonly string[] }) => launch(request.args).wait(),
      spawn: async (request: { args: readonly string[] }) => launch(request.args),
      clients: { connectJsonRpc: (request: { endpoint: { socketPath: string }; maxFrameBytes?: number; requestTimeoutMs?: number }, options?: { signal?: AbortSignal }) =>
        connectManagedJsonRpcTestClient({ cwd: workspace, socketPath: request.endpoint.socketPath,
          maxFrameBytes: request.maxFrameBytes, requestTimeoutMs: request.requestTimeoutMs, signal: options?.signal }) },
    } as unknown as ExecService;
    const signal = new AbortController().signal;
    // These host ports are outside the native model boundary exercised here.
    const publisher: ReturnType<AgentSessionRuntimeContext['workState']['publisher']> = {
      publish: async snapshot => ({ status: 'applied', revision: '1', sourceSequence: snapshot.sourceSequence }),
    };
    const context = { signal, workState: { publisher: () => publisher },
      services: { exec, sessions: {}, logger: { debug() {}, info() {}, warn() {}, error() {} } },
      agent: { id: 'codex' }, session: { id: 'voice-prompt-cost', services: {} }, ui: { title: { set: async () => undefined } },
    } as unknown as AgentSessionRuntimeContext;
    let active: AgentSessionRuntime | undefined;
    const cleanup = async () => {
      await active?.dispose(); active = undefined;
      for (const child of children) await child.dispose();
      model.closeAllConnections();
      if (model.listening) await new Promise<void>(resolve => model.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    };
    onTestFinished(cleanup);
    try {
      const version = new TextDecoder().decode((await launch(['--version']).wait()).stdout).trim();
      const catalog = JSON.parse(new TextDecoder().decode((await launch(['debug', 'models']).wait()).stdout)) as { models: Record<string, unknown>[] };
      const selected = catalog.models.find(item => item.tool_mode === 'code_mode_only');
      expect(selected).toBeDefined();
      await writeFile(join(codexHome, 'models.json'), JSON.stringify({ models: [{ ...selected,
        slug: 'voice-cost-model', prefer_websockets: false, use_responses_lite: false }] }));
      await writeFile(join(codexHome, 'config.toml'), [
        'cloud.skills.enabled=false', 'model_provider="offline"', 'model="voice-cost-model"',
        `model_catalog_json=${JSON.stringify(join(codexHome, 'models.json'))}`,
        '[model_providers.offline]', 'name="Offline loopback"', `base_url=${JSON.stringify(endpoint)}`,
        'wire_api="responses"', 'requires_openai_auth=false',
      ].join('\n'));
      const descriptor = getVoiceActionFunctionTool();
      const prompt = buildLocalVoiceAgentSystemPrompt();
      for (const promptProfile of [undefined, 'conversation'] as const) {
        const runtime = await createCodexAgentRuntime({ plugin: { id: 'happier.agent.codex', version: '1.0.0' }, agent: { id: 'codex' }, signal });
        active = await runtime.sessions!.open({ kind: 'create', sessionId: context.session.id, cwd: workspace, promptProfile,
          launchEnvironment: { values: env, unset: [] }, functionTools: [{ ...descriptor, call: async () => ({ ok: true }) }],
          configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: 'voice-cost-model', updatedAtMs: 1 },
            permissionIntent: { value: 'default', updatedAtMs: 1 }, options: {} } }, context);
        let settle!: (event: AgentSessionRuntimeEvent) => void;
        const complete = new Promise<AgentSessionRuntimeEvent>(resolve => { settle = resolve; });
        const watch = active.watch(event => { if (event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled') settle(event); });
        await active.send({ inputIds: ['voice-cost-input'], input: { text: prompt }, delivery: { kind: 'newTurn', turnId: 'voice-cost-turn' } });
        expect(await complete).toMatchObject({ kind: 'turn-complete' });
        watch.dispose(); await active.dispose(); active = undefined;
      }
      expect(requests).toHaveLength(2);
      const text = (request: ModelRequest) => (request.input ?? []).flatMap(item => (item.content ?? []).map(content => content.text ?? '')).join('\n');
      expect(text(requests[0])).toContain('VOICE_COST_REPOSITORY_INSTRUCTION');
      for (let i = 0; i < 46; i++) expect(text(requests[0])).toContain(`VOICE_COST_SKILL_${i}`);
      expect(text(requests[1]).includes('VOICE_COST_REPOSITORY_INSTRUCTION')).toBe(false);
      expect(text(requests[1]).includes('VOICE_COST_SKILL_')).toBe(false);
      for (const request of requests) {
        expect(text(request).includes(prompt)).toBe(true);
        expect(JSON.stringify(request.tools).includes(descriptor.name)).toBe(true);
      }
      const cost = requests.map(request => ({ inputBytes: Buffer.byteLength(JSON.stringify(request.input)), toolsBytes: Buffer.byteLength(JSON.stringify(request.tools)), toolCount: request.tools?.length }));
      expect(cost[1].inputBytes).toBeLessThan(cost[0].inputBytes);
      expect(requests[1].tools).toEqual(requests[0].tools);
      console.log(JSON.stringify({ version, selectedModel: selected?.slug, toolMode: selected?.tool_mode,
        promptBytes: Buffer.byteLength(prompt), skillCount: 46, default: cost[0], conversation: cost[1], deniedExternalHosts }));
    } finally { await cleanup(); }
  }, 60_000);
});
