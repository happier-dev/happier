import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import type { ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createOpenCodeServerTransport } from '../../../../../../packages/plugins/opencode/src/agent/runtime/server/transport';
import { createOpenCodeServerClient } from '../../../../../../packages/plugins/opencode/src/agent/runtime/server/openCodeServerClient';

function isSpawnSpec(spec: ManagedServiceSpec): spec is Extract<ManagedServiceSpec, { mode: { kind: 'spawn' } }> {
  return spec.mode.kind === 'spawn';
}

function vendorEvents(provider: 'anthropic' | 'openai', model: string): string {
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  if (provider === 'anthropic') return [
    event('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'FIX69 READY' } }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }),
    event('message_stop', {}),
  ].join('');
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'FIX69 READY', annotations: [] }] };
  const response = { id: 'resp_fixture', object: 'response', created_at: 1, model, status: 'completed',
    output: [item], usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  return [
    event('response.created', { response: { ...response, status: 'in_progress', output: [] } }),
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } }),
    event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }),
    event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'FIX69 READY' }),
    event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: 'FIX69 READY' }),
    event('response.output_item.done', { output_index: 0, item }),
    event('response.completed', { response }),
  ].join('');
}

/** Real host → owned OpenCode → generated request-auth leaf → fixture vendor HTTP.
 * The additional native plugin redirects only vendor IO; host auth and native
 * request handling are real. Every file/process belongs to this test's temp root.
 */
export async function assertOpenCodeManagedPrompt(input: Readonly<{
  executable: string;
  directory: string;
  configHome: string;
  spec: ManagedServiceSpec;
  provider: 'anthropic' | 'openai';
  model: string;
}>): Promise<void> {
  await mkdir(input.directory, { recursive: true });
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const requests: Array<{ authorization: string | undefined; accountId: string | undefined }> = [];
  const vendor = createServer(async (request, response) => {
    requests.push({ authorization: request.headers.authorization,
      accountId: typeof request.headers['chatgpt-account-id'] === 'string' ? request.headers['chatgpt-account-id'] : undefined });
    request.resume();
    entered();
    await held;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(vendorEvents(input.provider, input.model));
  });
  await new Promise<void>(resolve => vendor.listen(0, '127.0.0.1', resolve));
  const address = vendor.address();
  if (!address || typeof address === 'string') throw new Error('Expected vendor TCP address');
  // OpenCode V1 discovers the generated auth plugin and this test-only vendor
  // adapter in the same native config directory.
  await writeFile(join(input.configHome, 'opencode', 'plugin', 'fixture-vendor.js'), `
export const FixtureVendor = async () => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (request, init) => {
    const url = new URL(typeof request === 'string' || request instanceof URL ? String(request) : request.url);
    if (url.origin === 'https://api.anthropic.com' || url.origin === 'https://chatgpt.com') {
      return nativeFetch('http://127.0.0.1:${address.port}' + url.pathname, init);
    }
    return nativeFetch(request, init);
  };
  return {};
};
`, { mode: 0o600 });
  const executable = { kind: 'systemTool', id: 'opencode-cli' } as const;
  const exec = createStablePluginExecService({
    signal: new AbortController().signal,
    isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: input.executable }),
    resolveManagedExecutable: async () => ({ command: input.executable }), resolvePath: async () => input.directory });
  const unusedDependency = async (): Promise<never> => { throw new Error('Unexpected managed dependency'); };
  const owner = createManagedServicesOwner({ processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
    dependencies: { ensure: unusedDependency, status: unusedDependency, update: unusedDependency, remove: unusedDependency },
    registerRawForRedaction() {},
    resolveScope: scope => scope });
  try {
    if (!isSpawnSpec(input.spec)) throw new Error('Expected owned native server');
    const handle = await owner.bindScope({ occurrenceId: 'external-opencode-fixture', pluginId: 'external.fixture',
      contributionQualifiedId: 'external.fixture/agents/opencode', operationId: 'prompt', isOccurrenceCurrent: () => true }, exec).supervise({
      ...input.spec, durableLog: undefined, mode: { ...input.spec.mode, launch: { ...input.spec.mode.launch,
        env: { ...input.spec.mode.launch.env, XDG_DATA_HOME: join(input.directory, 'native-data'),
          XDG_CACHE_HOME: join(input.directory, 'native-cache'), XDG_STATE_HOME: join(input.directory, 'native-state') } } },
    });
    await handle.waitUntilHealthy();
    const nativePids = owner.readProcessRoots().map(root => root.pid);
    expect(nativePids).toHaveLength(1);
    const caller = new AbortController();
    const client = createOpenCodeServerClient({ transport: createOpenCodeServerTransport({ managedService: handle, signal: caller.signal }),
      dialect: 'v1', directory: input.directory, signal: caller.signal });
    const session = await client.sessionCreate({ directory: input.directory });
    const title = await handle.request({ method: 'PATCH', pathAndQuery: `/session/${session.id}`,
      headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ title: 'FIX69 owned fixture' })) });
    await title.body?.cancel();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = client.sessionPromptAsync({ sessionId: session.id, text: 'Reply FIX69 READY. No tools.',
      model: { providerID: input.provider, modelID: input.model } }).then(value => ({ value }), error => ({ error }));
    expect(await Promise.race([started.then(() => 'vendor'), pending])).toBe('vendor');
    await vi.advanceTimersByTimeAsync(300_001);
    release();
    vi.useRealTimers();
    const result = await pending;
    expect(result).not.toHaveProperty('error');
    expect(JSON.stringify(result)).toContain('FIX69 READY');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(request => request.authorization === 'Bearer fixture-access'
      && request.accountId === (input.provider === 'openai' ? 'fixture-account' : undefined))).toBe(true);
    // A retired/wrong handle must fail before it can make another vendor call.
    const count = requests.length;
    await handle.dispose();
    for (const pid of nativePids) expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
    await expect(client.sessionPromptAsync({ sessionId: session.id, text: 'must refuse' })).rejects.toMatchObject({ code: 'plugin_managed_service_unavailable' });
    expect(requests).toHaveLength(count);
  } finally {
    release();
    vi.useRealTimers();
    await owner.dispose();
    vendor.closeAllConnections();
    await new Promise<void>((resolve, reject) => vendor.close(error => error ? reject(error) : resolve()));
  }
}
