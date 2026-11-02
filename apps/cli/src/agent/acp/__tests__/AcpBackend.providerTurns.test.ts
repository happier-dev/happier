import { describe, expect, it, vi } from 'vitest';
import { createAcpBackend } from '../createAcpBackend';
import { writeProviderTurnAgent } from '../testkit/providerTurnAgent';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { AgentMessage } from '@/agent/core';
import type { AgentAcpProviderTurnSourceHost } from '@happier-dev/plugin-sdk/agents/runtime';



describe('ACP provider continuation source', () => {
  it('opens with the session and routes authorized continuation output through the real ACP owner', async () => {
    await withTempDir('provider-turns-', async directory => {
      let host: AgentAcpProviderTurnSourceHost | undefined;
      const tasks = new Set<string>();
      const events: AgentMessage[] = [];
      const backend = createAcpBackend({
        agentName: 'fixture', cwd: directory, command: process.execPath, args: [writeProviderTurnAgent(directory)],
        providerTurnSource: async value => { host = value; return { catchUp: async () => {}, dispose() {} }; },
        providerTurnLifecycle: {
          registerContinuation: ({ id }) => { tasks.add(id); return true; },
          beginContinuation: ({ id }) => tasks.delete(id),
          releaseToolCalls() {},
          dispose() { tasks.clear(); },
        },
      });
      backend.onMessage(event => { events.push(event); });
      try {
        await backend.startSession();
        expect(host, 'source opens before session readiness').toBeDefined();
        await backend.sendPrompt('owned', 'first');
        await backend.waitForResponseComplete();
        expect(host!.registerContinuation({ id: 'task', parentToolCallId: '0:background' })).toBe(true);
        events.length = 0;
        const sink = host!.beginContinuation({ id: 'task', turnId: '1' });
        expect(sink).not.toBeNull();
        await backend.requestExtension('test/late', {});
        expect(events.some(event => event.type === 'model-output' && event.textDelta === 'LATE_FOREGROUND')).toBe(false);
        await sink!.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CONTINUATION' } });
        expect(events.some(event => event.type === 'model-output' && event.textDelta === 'CONTINUATION')).toBe(true);
        await sink!.finish({ kind: 'completed' });
        await backend.waitForResponseComplete();
        expect(backend.getLastTurnOutcome()).toMatchObject({ kind: 'completed' });
        expect(host!.beginContinuation({ id: 'task', turnId: '2' })).toBeNull();
      } finally { await backend.dispose(); }
    });
  });
});

it.each(['realpath', 'mkdir'] as const)('withdraws an old filesystem write held at %s before a successor can lend authority', async boundary => {
  await withTempDir('provider-fs-lifetime-', async directory => {
    const { promises: fs } = await import('node:fs');
    const { join } = await import('node:path');
    const { vi } = await import('vitest');
    const path = join(directory, 'protected.txt');
    await fs.writeFile(path, 'ORIGINAL');
    let host: AgentAcpProviderTurnSourceHost | undefined;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    const realpath = fs.realpath.bind(fs);
    const mkdir = fs.mkdir.bind(fs);
    const spy = boundary === 'realpath'
      ? vi.spyOn(fs, 'realpath').mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
          if (!held && String(args[0]) === path) { held = true; entered(); await gate; }
          return realpath(...args);
        })
      : vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
          if (!held && String(args[0]) === directory) { held = true; entered(); await gate; }
          return mkdir(...args);
        });
    const permissions = vi.fn(async () => ({ decision: 'approved' as const }));
    const backend = createAcpBackend({ agentName: 'fixture', cwd: directory, command: process.execPath,
      args: [writeProviderTurnAgent(directory)], permissionHandler: { handleToolCall: permissions },
      providerTurnSource: async value => { host = value; return { catchUp: async () => {}, dispose() {} }; },
      providerTurnLifecycle: { registerContinuation: () => true, beginContinuation: () => true,
        releaseToolCalls() {}, dispose() {} },
    });
    try {
      await backend.startSession();
      await backend.sendPrompt('owned', 'parent');
      await backend.waitForResponseComplete();
      expect(host!.beginContinuation({ id: 'task', turnId: '1' })).not.toBeNull();
      const writing = backend.requestExtension('test/write', { path });
      await reached;
      await backend.cancel('owned');
      expect(host!.beginContinuation({ id: 'successor', turnId: '2' })).not.toBeNull();
      const permissionCount = permissions.mock.calls.length;
      release();
      expect(await writing).toHaveProperty('error');
      expect(permissions).toHaveBeenCalledTimes(permissionCount);
      expect(await fs.readFile(path, 'utf8')).toBe('ORIGINAL');
    } finally { release(); spy.mockRestore(); await backend.dispose(); }
  });
});

it('uses the finalized spawned environment for the source and closes it before accepting a successor', async () => {
  await withTempDir('provider-env-', async directory => {
    vi.stubEnv('SOURCE_UNSET', 'drop');
    let host: AgentAcpProviderTurnSourceHost | undefined;
    const backend = createAcpBackend({ agentName: 'fixture', cwd: directory, command: process.execPath,
      args: [writeProviderTurnAgent(directory)], env: { SOURCE_EXPLICIT: 'first' }, unsetEnv: ['SOURCE_UNSET'],
      transformAgentChildLaunchEnvironment: env => ({ ...env, SOURCE_EXPLICIT: 'prepared' }),
      providerTurnSource: async value => { host = value; return { catchUp: async () => {}, dispose() {} }; },
      providerTurnLifecycle: { registerContinuation: () => true, beginContinuation: () => true,
        releaseToolCalls() {}, dispose() {} },
    });
    try {
      await backend.startSession();
      expect(host!.env).toMatchObject({ SOURCE_EXPLICIT: 'prepared' });
      expect(host!.env).not.toHaveProperty('SOURCE_UNSET');
      const old = host!;
      await backend.requestExtension('test/hold-close', {});
      const cancel = backend.cancel('owned');
      await expect.poll(() => old.signal.aborted).toBe(true);
      await expect(backend.sendPrompt('owned', 'during cancellation')).rejects.toThrow();
      const joined = backend.cancel('owned');
      await backend.requestExtension('test/release-close', {});
      await Promise.all([cancel, joined]);
      expect(await backend.requestExtension('test/status', {})).toMatchObject({ closes: 1, loads: 1 });
      expect(old.beginContinuation({ id: 'stale', turnId: '1' })).toBeNull();
      await backend.sendPrompt('owned', 'after');
      await backend.waitForResponseComplete();
    } finally { await backend.dispose(); vi.unstubAllEnvs(); }
  });
});

it('does not admit an old filesystem request when its journal catch-up spans source replacement', async () => {
  await withTempDir('provider-catchup-lifetime-', async directory => {
    const { promises: fs } = await import('node:fs');
    const { join } = await import('node:path');
    const path = join(directory, 'protected.txt');
    await fs.writeFile(path, 'ORIGINAL');
    let host: AgentAcpProviderTurnSourceHost | undefined;
    let hold = false;
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const permissions = vi.fn(async () => ({ decision: 'approved' as const }));
    const backend = createAcpBackend({ agentName: 'fixture', cwd: directory, command: process.execPath,
      args: [writeProviderTurnAgent(directory)], permissionHandler: { handleToolCall: permissions },
      providerTurnSource: async value => { host = value; return { catchUp: async () => {
        if (hold) { hold = false; entered(); await gate; }
      }, dispose() {} }; },
      providerTurnLifecycle: { registerContinuation: () => true, beginContinuation: () => true,
        releaseToolCalls() {}, dispose() {} },
    });
    try {
      await backend.startSession();
      expect(host!.beginContinuation({ id: 'task', turnId: '1' })).not.toBeNull();
      hold = true;
      const writing = backend.requestExtension('test/write', { path });
      await reached;
      await backend.cancel('owned');
      expect(host!.beginContinuation({ id: 'next', turnId: '2' })).not.toBeNull();
      release();
      expect(await writing).toHaveProperty('error');
      expect(permissions).not.toHaveBeenCalled();
      expect(await fs.readFile(path, 'utf8')).toBe('ORIGINAL');
    } finally { release(); await backend.dispose(); }
  });
});
