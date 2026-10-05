import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ResourceUpdatedNotificationSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  createActionExecutor, projectSessionAwarenessV1, waitForSessionAwarenessV1,
  SessionAwarenessProjectionV1Schema, WaitActionResultV1Schema, type ActionExecutorDeps,
} from '@happier-dev/protocol';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { registerHappierMcpResources } from './registerHappierMcpResources';

const input = { target: { kind: 'session', serverId: 'home', sessionId: 'session' }, condition: { kind: 'terminal' } };

async function fixture(isEnabled = true) {
  let active = true;
  let revision = 0;
  let reads = 0;
  let pauseReads = false;
  const readingSignals = new Set<AbortSignal>();
  const listeners = new Set<() => void>();
  // Session reads and invalidation are the storage/socket boundary. Real
  // Action admission, awareness projection, passive owner and MCP transport run.
  const owner = createActionExecutor({
    sessionActivityGet: async ({ signal }) => {
      reads++;
      if (pauseReads && signal) {
        readingSignals.add(signal);
        await new Promise<void>((resolve) => {
          const aborted = () => { readingSignals.delete(signal); resolve(); };
          if (signal.aborted) aborted();
          else signal.addEventListener('abort', aborted, { once: true });
        });
      }
      return projectSessionAwarenessV1({ nowMs: 1_800_000_000_000, sessionId: 'session', lifecycle: {},
        runtime: { presence: 'online', active: true, thinking: active, thinkingAtMs: 1_800_000_000_000 }, pending: {}, content: { mode: 'plain' },
        currentness: { lifecycle: 'observed', runtime: 'observed', pending: 'observed' },
      });
    },
    sessionAwarenessWait: async ({ input: request, options, readAwareness }) => waitForSessionAwarenessV1({
      condition: request.condition, deadlineMs: options.deadlineMs, signal: options.signal, onSnapshot: options.onSnapshot,
      read: async () => ({ awareness: SessionAwarenessProjectionV1Schema.parse(await readAwareness()) }),
      open: () => ({ currentRevision: () => revision, close: async () => {},
        waitForChange: async (previous, { signal }) => {
          if (previous !== revision) return true;
          if (signal?.aborted) return false;
          return await new Promise<boolean>((resolve) => {
            const done = () => { listeners.delete(wake); signal?.removeEventListener('abort', abort); resolve(!signal?.aborted); };
            const wake = () => done();
            const abort = () => done();
            listeners.add(wake);
            signal?.addEventListener('abort', abort, { once: true });
          });
        },
      }),
    }),
  } satisfies Pick<ActionExecutorDeps, 'sessionActivityGet' | 'sessionAwarenessWait'> as unknown as ActionExecutorDeps);
  const bridge = createActionToolExecutorBridge({ surface: 'mcp', executor: {
    execute: (id, value, context) => owner.execute(id, value, { ...context, serverId: 'home' }),
  } });
  const server = new McpServer({ name: 'watch-test', version: '1' }, { capabilities: { resources: { subscribe: true } } });
  registerHappierMcpResources(server, {
    surface: 'mcp', watch: { server, execute: bridge.executeActionByToolName, defaultSessionId: 'session', isEnabled: () => isEnabled },
  });
  const client = new Client({ name: 'watch-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, server, listeners, readingSignals, get reads() { return reads; }, pauseReads: () => { pauseReads = true; },
    change: () => { active = false; revision++; for (const wake of [...listeners]) wake(); },
  };
}

function payload(result: Awaited<ReturnType<Client['callTool']>>) {
  const text = CallToolResultSchema.parse(result).content.find((entry) => entry.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Missing text result');
  return JSON.parse(text.text);
}

describe('MCP passive watch over the real observation owner', () => {
  it.each(['unsubscribe', 'disconnect'] as const)('delivers a change hint and fresh read; %s releases observation', async (cleanup) => {
    const f = await fixture();
    try {
      expect(f.client.getServerCapabilities()?.resources?.subscribe).toBe(true);
      for (const invalid of [
        { ...input, unexpected: true },
        { ...input, target: { ...input.target, unexpected: true } },
      ]) {
        expect(await f.client.callTool({ name: 'watch', arguments: invalid })).toMatchObject({ isError: true });
        expect(f.reads).toBe(0);
        expect(f.listeners.size).toBe(0);
      }
      const watched = payload(await f.client.callTool({ name: 'watch', arguments: {
        ...input, target: { ...input.target, serverId: ' home ', sessionId: ' session ' },
      } }));
      expect(watched).toMatchObject({ target: input.target, condition: input.condition, resourceUri: expect.any(String) });
      const uri = watched.resourceUri as string;
      const baseline = await f.client.readResource({ uri });
      if (!baseline.contents[0] || !('text' in baseline.contents[0])) throw new Error('Missing text resource');
      expect(JSON.parse(String(baseline.contents[0]!.text)).snapshot.awareness.runtime).toBe('working');
      expect(f.listeners.size).toBe(0);
      const notifications: string[] = [];
      f.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => { notifications.push(n.params.uri); });
      await f.client.subscribeResource({ uri });
      await f.client.subscribeResource({ uri }); // idempotent, no duplicate owner observation
      await expect.poll(() => f.listeners.size).toBe(1);
      expect(notifications).toEqual([]);
      f.change();
      await expect.poll(() => notifications).toEqual([uri]);
      const current = await f.client.readResource({ uri });
      if (!current.contents[0] || !('text' in current.contents[0])) throw new Error('Missing text resource');
      expect(JSON.parse(String(current.contents[0]!.text)).snapshot.awareness.runtime).toBe('idle');
      if (cleanup === 'unsubscribe') await f.client.unsubscribeResource({ uri });
      else await f.client.close();
      await expect.poll(() => f.listeners.size).toBe(0);
      const reads = f.reads;
      f.change();
      expect(f.reads).toBe(reads);
      expect(notifications).toEqual([uri]);
    } finally { await f.client.close(); await f.server.close(); }
  });

  it.each([
    { target: { kind: 'execution_run', serverId: 'home', machineId: 'machine', runId: 'run' }, condition: { kind: 'terminal' } },
    { target: { kind: 'workflow_run', serverId: 'home', runId: 'run' }, condition: { kind: 'terminal_or_needs_attention' } },
    { target: { kind: 'plugin_source', serverId: 'home', pluginId: 'acme.checks', sourceId: 'checkpoint' },
      condition: { kind: 'plugin', actionLocalId: 'observe/checks', condition: 'checks_passed' } },
  ])('refuses unsupported passive targets in tools and subscribe with the same typed disposition: $target.kind', async (request) => {
    const f = await fixture();
    try {
      const refused = payload(await f.client.callTool({ name: 'watch', arguments: request }));
      expect(refused).toMatchObject({ target: request.target, disposition: 'unsupported_condition' });
      expect(refused.resourceUri).toBeUndefined();
      const uri = `happier://watch/${Buffer.from(JSON.stringify(request)).toString('base64url')}`;
      try {
        await f.client.subscribeResource({ uri });
        throw new Error('Expected typed refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).data).toMatchObject({ target: request.target, disposition: 'unsupported_condition' });
      }
      expect(f.listeners.size).toBe(0);
    } finally { await f.client.close(); await f.server.close(); }
  });

  it('a crafted resource URI cannot bypass captured Home admission', async () => {
    const f = await fixture();
    try {
      const request = { ...input, target: { ...input.target, serverId: 'other-home' } };
      const uri = `happier://watch/${Buffer.from(JSON.stringify(request)).toString('base64url')}`;
      await expect(f.client.readResource({ uri })).rejects.toMatchObject({ data: { disposition: 'permission_denied' } });
      await expect(f.client.subscribeResource({ uri })).rejects.toMatchObject({ data: { disposition: 'permission_denied' } });
      expect(f.reads).toBe(0);
      expect(f.listeners.size).toBe(0);
    } finally { await f.client.close(); await f.server.close(); }
  });

  it('disconnect also cancels an in-flight watch baseline read', async () => {
    const f = await fixture();
    try {
      f.pauseReads();
      const result = f.client.callTool({ name: 'watch', arguments: input }).catch(() => undefined);
      await expect.poll(() => f.readingSignals.size).toBe(1);
      const signal = [...f.readingSignals][0]!;
      await f.client.close();
      await result;
      expect(signal.aborted).toBe(true);
      expect(f.readingSignals.size).toBe(0);
    } finally { await f.client.close(); await f.server.close(); }
  });

  it('a disabled Action refuses without reads and preserves the strict observation result shape', async () => {
    const f = await fixture(false);
    try {
      const request = { ...input, timeout: { durationMs: 10 } };
      const refused = payload(await f.client.callTool({ name: 'watch', arguments: request }));
      expect(refused).toMatchObject({ target: input.target, disposition: 'permission_denied' });
      expect(WaitActionResultV1Schema.safeParse(refused).success).toBe(true);
      expect(f.reads).toBe(0);
      expect(f.listeners.size).toBe(0);
    } finally { await f.client.close(); await f.server.close(); }
  });
});
