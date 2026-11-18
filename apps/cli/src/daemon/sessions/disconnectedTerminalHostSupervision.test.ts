import { afterAll, describe, expect, it, vi } from 'vitest';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import type { TerminalHostAdapter, TerminalHostHandle } from '@happier-dev/agents';
import axios, { AxiosHeaders } from 'axios';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';

import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { readTerminalHostAttachmentInfo, writeTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { retireExactTerminalControlServiceability } from './retireTerminalControlServiceability';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDaemonPluginDevelopmentRootsOwner } from '@/plugins/daemon/developmentRoots';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import {
  resolveDisconnectedTerminalMode,
  resolveDisconnectedTerminalHostResumeGate,
  resolveTrackedSessionTerminalHostExitCandidate,
  shouldRetainTrackedTerminalHostExitMarker,
  superviseDisconnectedTerminalHostCandidate,
  superviseTrackedOptionalTerminalPresentation,
} from './disconnectedTerminalHostSupervision';

const handle: TerminalHostHandle & { attachmentId: NonNullable<TerminalHostHandle['attachmentId']> } = {
  attachmentId: 'attachment-live-1' as NonNullable<TerminalHostHandle['attachmentId']>,
  kind: 'tmux',
  sessionName: 'happier-live-1',
  paneId: 'claude.1',
  attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
};

function adapter(liveness: Awaited<ReturnType<TerminalHostAdapter['evaluateLiveness']>>): TerminalHostAdapter {
  return {
    kind: 'tmux', createOrAttachHost: vi.fn(), injectUserPrompt: vi.fn(), interruptTurn: vi.fn(),
    evaluateLiveness: vi.fn(async () => liveness), dispose: vi.fn(async () => undefined),
  };
}

function attachment() {
  return { version: 2 as const, attachmentId: handle.attachmentId, sessionId: 'session-live-1', handle, updatedAt: 1 };
}

describe('disconnected terminal-host supervision', () => {
  // The real singleton's shutdown is terminal, not a per-case reset.
  afterAll(async () => { await pluginReloadController.shutdown(); });
  it.each(['absent', 'unreadable', 'replacement'] as const)('distinguishes missing final-exit attachment from unresolved custody: %s', async state => {
    await withConfiguredDaemonTestHome({ prefix: 'final-host-exit-' }, async ({ homeDir }) => {
      const tracked = { trackingKey: legacyPidSessionTrackingKey(999_123_456), pid: 999_123_456, startedBy: 'daemon' as const, happySessionId: 'session-live-1',
        hostedTerminal: { mode: 'tmux' as const }, publishedTerminalControlServiceabilityAttachmentId: 'old-host' };
      if (state !== 'absent') {
        await writeTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId: tracked.happySessionId, handle });
        if (state === 'unreadable') await writeFile(join(homeDir, 'terminal', 'sessions', 'session-live-1.host.json'), '{');
      }
      expect(await shouldRetainTrackedTerminalHostExitMarker({ tracked, happyHomeDir: homeDir })).toBe(state !== 'absent');
      const candidate = resolveTrackedSessionTerminalHostExitCandidate({ tracked, pid: tracked.pid,
        happyHomeDir: homeDir, attachmentInfo: null });
      if (state === 'absent') await expect(candidate).resolves.toBeNull();
      else await expect(candidate).rejects.toThrow('terminal_host_attachment_unavailable_after_runner_exit');
    });
  });
  it('retires an exited plain runner without resolving the Account catalog', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'plain-exit-offline-' }, async ({ homeDir }) => {
      const get = vi.spyOn(axios, 'get').mockRejectedValue(Object.assign(new Error('Home unreachable'), { code: 'ECONNREFUSED' }));
      try {
        const tracked = { trackingKey: legacyPidSessionTrackingKey(999_123_456), pid: 999_123_456, startedBy: 'daemon' as const, happySessionId: 'plain-offline',
          spawnOptions: { directory: homeDir,
            backendTarget: { kind: 'backend' as const, sourceKind: 'built_in' as const, backendId: 'codex' as const },
            runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: { backendMode: 'acp' } } } };
        await expect(shouldRetainTrackedTerminalHostExitMarker({ tracked, happyHomeDir: homeDir })).resolves.toBe(false);
        await expect(resolveTrackedSessionTerminalHostExitCandidate({ tracked, pid: tracked.pid,
          happyHomeDir: homeDir, attachmentInfo: null })).resolves.toBeNull();
        expect(get).not.toHaveBeenCalled();
      } finally { get.mockRestore(); }
    });
  });
  it('retires a dead borrowed native client through the existing heartbeat without retiring its controller or shell', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'borrowed-client-heartbeat-' }, async ({ homeDir }) => {
      await withHerdrApi(async api => {
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
        await once(child, 'spawn');
        const pid = child.pid!;
        const fingerprint = readProcessInstanceFingerprintSync(pid);
        if (!fingerprint) throw new Error('The real native child has no process identity');
        const sessionId = 'session-live-1';
        const exactHandle: TerminalHostHandle = { kind: 'herdr', sessionName: 'work', socketPath: api.socketPath,
          terminalId: 'terminal_1', paneId: 'managed',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' } };
        api.panes.add('managed');
        const attachmentInfo = await writeTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId,
          handle: exactHandle, lifecycle: 'borrowed', nativeClientProcess: { pid, processInstanceFingerprint: fingerprint } });
        const metadata = JSON.stringify({ path: '/repo', terminal: { mode: 'herdr', herdr: {
          sessionName: 'work', socketPath: api.socketPath, terminalId: 'terminal_1', paneId: 'managed' },
          controlServiceabilityV1: { v: 1, attachmentId: attachmentInfo.attachmentId, state: 'servable', observedAt: 1 } } });
        const raw = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 0, metadata });
        const response = { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
        const get = vi.spyOn(axios, 'get').mockImplementation(async url => ({ ...response,
          data: String(url).includes('/v2/sessions/') ? { session: raw } : {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }));
        const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ ...response, data: {
          success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 2 }, agentState: { version: 1 } } });
        try {
          const observe = () => superviseTrackedOptionalTerminalPresentation({
            tracked: { trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, startedBy: 'daemon', happySessionId: sessionId },
            happyHomeDir: homeDir, isCurrent: () => true,
            loadTerminalHostAdapters: async () => { throw new Error('Borrowed client retirement must not dispose the shell'); },
            retireExactTerminalControlServiceability: fact => retireExactTerminalControlServiceability({
              credentials: { token: 'test-token', encryption: null }, sessionId: fact.sessionId,
              attachmentId: fact.attachmentInfo.attachmentId, terminalMode: fact.terminalMode }),
          });
          await observe();
          expect(await readTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId })).toMatchObject({
            version: 3, nativeClientProcess: { pid } });
          expect(patch).not.toHaveBeenCalled();
          const exited = once(child, 'exit');
          child.kill('SIGTERM');
          await exited;
          await observe();
          expect(await readTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId })).toBeNull();
          expect(patch).toHaveBeenCalled();
          expect(process.kill(process.pid, 0)).toBe(true);
          expect(api.panes.has('managed')).toBe(true);
          expect(api.requests.some(request => request.method === 'pane.close')).toBe(false);
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          get.mockRestore(); patch.mockRestore();
        }
      });
    });
  });
  it('costs no Session call per heartbeat for a live provider-attach host whose runner is a healthy tracked child', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'optional-presentation-idle-' }, async ({ homeDir }) => {
      const developmentRoots = createDaemonPluginDevelopmentRootsOwner({ happyHomeDir: homeDir,
        submitObservation: async () => { throw new Error('This case observes no development sources'); } });
      const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: homeDir, generation: 1,
        resolveDevelopmentSourceAuthority: developmentRoots.resolveDevelopmentSourceAuthority });
      const adoption = await pluginReloadController.adoptPreparedRuntimeRegistry({ registry, changedPluginIds: [],
        durableRevision: 1, runningSessionDisposition: 'retainRunningSessions' });
      if (!adoption.ok) throw new Error('The daemon runtime registry was not adopted');
      const sessionId = 'session-live-1';
      await writeTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId, handle });
      const host = adapter({ paneAlive: true, observedAt: 1 });
      const sessionCalls = vi.fn(async () => ({ state: 'runner_present' as const, control: { state: 'servable' as const } }));
      const tracked = { trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, startedBy: 'daemon' as const,
        happySessionId: sessionId, spawnOptions: { directory: homeDir,
          backendTarget: { kind: 'backend' as const, sourceKind: 'built_in' as const, backendId: 'codex' as const },
          runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } } } };
      for (let tick = 0; tick < 10; tick += 1) {
        await superviseTrackedOptionalTerminalPresentation({
          tracked, happyHomeDir: homeDir, isCurrent: () => true,
          loadTerminalHostAdapters: async () => ({ tmux: host }),
          // Supplied anyway: a live host must not reach a Session call even when one is offered.
          probeSessionServiceability: sessionCalls,
          retireExactTerminalControlServiceability: async () => { throw new Error('A live host is not retired'); },
        } as Parameters<typeof superviseTrackedOptionalTerminalPresentation>[0]);
      }
      expect(host.evaluateLiveness).toHaveBeenCalledTimes(10);
      expect(sessionCalls.mock.calls.length).toBe(0);
      expect(await readTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId })).toMatchObject({ version: 2 });
    });
  });
  it('derives the terminal mode from exact host identity without duplicating platform rules', () => {
    expect(resolveDisconnectedTerminalMode({
      terminal: undefined,
      hostKind: 'tmux',
      attachmentId: 'attachment-tmux',
    })).toBe('tmux');
    expect(resolveDisconnectedTerminalMode({
      terminal: undefined,
      hostKind: 'herdr',
      attachmentId: 'attachment-herdr',
    })).toBe('herdr');
    expect(resolveDisconnectedTerminalMode({
      terminal: {
        mode: 'windows_terminal',
        controlServiceabilityV1: {
          v: 1,
          attachmentId: 'attachment-windows',
          state: 'servable',
          observedAt: 1,
        },
      },
      hostKind: 'pty',
      attachmentId: 'attachment-windows',
    })).toBe('windows_terminal');
    // A holder-terminal Session (POSIX pty or Windows ConPTY) records realized mode `pty`.
    expect(resolveDisconnectedTerminalMode({
      terminal: { mode: 'pty', pty: { host: 'holder' } },
      hostKind: 'pty',
      attachmentId: 'attachment-holder',
    })).toBe('pty');
    expect(resolveDisconnectedTerminalMode({
      terminal: {
        mode: 'windows_console',
        controlServiceabilityV1: {
          v: 1,
          attachmentId: 'replacement-attachment',
          state: 'servable',
          observedAt: 1,
        },
      },
      hostKind: 'pty',
      attachmentId: 'attachment-windows',
    })).toBeNull();
  });

  it('carries admitted retained continuation into placement without treating ordinary resume as adoption', () => {
    const recovery = { controlDescriptorAvailable: true, retainedTerminalRecovery: 'adopt' as const };
    expect(resolveDisconnectedTerminalHostResumeGate({ state: 'recoverable_unservable', reason: 'runner_absent' }, recovery))
      .toEqual({ action: 'resume', retainedTerminalRecovery: 'adopt' });
    expect(resolveDisconnectedTerminalHostResumeGate({ state: 'stopped' }, recovery)).toEqual({ action: 'resume' });
    expect(resolveDisconnectedTerminalHostResumeGate({ state: 'servable' }, recovery)).toEqual({ action: 'resume' });
    expect(resolveDisconnectedTerminalHostResumeGate({ state: 'recoverable_unservable', reason: 'runner_absent' }, {
      controlDescriptorAvailable: false, retainedTerminalRecovery: 'adopt',
    })).toEqual({ action: 'fence', reason: 'runner_absent' });
    expect(resolveDisconnectedTerminalHostResumeGate({ state: 'recoverable_unservable', reason: 'runner_absent' }, {
      controlDescriptorAvailable: true,
    })).toEqual({ action: 'fence', reason: 'runner_absent' });
  });

  it('fences an exact preserved host that lacks its attachment-bound control descriptor', async () => {
    const hostAdapter = adapter({ paneAlive: true, observedAt: 1 });
    const result = await superviseDisconnectedTerminalHostCandidate({
      candidate: { sessionId: 'session-live-1', trackingKey: legacyPidSessionTrackingKey(42), pid: 42, happyHomeDir: '/tmp/happy', attachmentId: handle.attachmentId, handle, controlDescriptorAvailable: false },
      terminalHostAdapters: { tmux: hostAdapter },
      readTerminalAttachmentInfo: async () => attachment(),
      probeSessionServiceability: vi.fn(),
    });
    expect(result).toEqual({ state: 'recoverable_unservable', reason: 'control_descriptor_missing' });
    expect(resolveDisconnectedTerminalHostResumeGate(result)).toEqual({ action: 'fence', reason: 'control_descriptor_missing' });
    expect(hostAdapter.dispose).not.toHaveBeenCalled();
  });

  it('retires only a positively dead exact attachment', async () => {
    const hostAdapter = adapter({ paneAlive: false, paneDead: true, observedAt: 1 });
    const removeAttachment = vi.fn(async (_input: unknown) => true);
    const removeMarker = vi.fn(async (_trackingKey: SessionTrackingKey) => undefined);
    const events: string[] = [];
    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: { sessionId: 'session-live-1', trackingKey: legacyPidSessionTrackingKey(42), pid: 42, happyHomeDir: '/tmp/happy', attachmentId: handle.attachmentId, handle },
      terminalHostAdapters: { tmux: hostAdapter },
      readTerminalAttachmentInfo: async () => attachment(),
      removeTerminalAttachmentInfo: async (input) => {
        events.push('local');
        return await removeAttachment(input);
      },
      removeSessionMarker: async (trackingKey) => {
        events.push('marker');
        await removeMarker(trackingKey);
      },
      retireExactTerminalControlServiceability: async () => {
        events.push('remote');
      },
    })).resolves.toEqual({ state: 'stopped' });
    expect(removeAttachment).toHaveBeenCalled();
    expect(removeMarker).toHaveBeenCalledWith(legacyPidSessionTrackingKey(42));
    expect(events).toEqual(['remote', 'local', 'marker']);
  });

  it('keeps local retry identity when confirmed-dead remote retirement fails', async () => {
    const removeAttachment = vi.fn(async (_input: unknown) => true);
    const removeMarker = vi.fn(async (_trackingKey: SessionTrackingKey) => undefined);
    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: { sessionId: 'session-live-1', trackingKey: legacyPidSessionTrackingKey(42), pid: 42, happyHomeDir: '/tmp/happy', attachmentId: handle.attachmentId, handle },
      terminalHostAdapters: { tmux: adapter({ paneAlive: false, paneDead: true, observedAt: 1 }) },
      readTerminalAttachmentInfo: async () => attachment(),
      removeTerminalAttachmentInfo: removeAttachment,
      removeSessionMarker: removeMarker,
      retireExactTerminalControlServiceability: async () => {
        throw new Error('metadata unavailable');
      },
    })).resolves.toEqual({ state: 'unknown', reason: 'retirement_failed' });
    expect(removeAttachment).not.toHaveBeenCalled();
    expect(removeMarker).not.toHaveBeenCalled();
  });

  it('retires the positively dead old host without changing a newer remote projection', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'dead-host-superseded-' }, async ({ homeDir }) => {
      const sessionId = 'session-live-1';
      await writeTerminalHostAttachmentInfo({
        happyHomeDir: homeDir, sessionId, handle,
      });
      const metadata = JSON.stringify({ path: '/repo', terminal: {
        mode: 'tmux', controlServiceabilityV1: {
          v: 1, attachmentId: 'replacement-attachment', state: 'servable', observedAt: 20,
        },
      } });
      const raw = createSessionRecordFixture({
        id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 0, metadata,
      });
      const response = { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
      // Genuine HTTP boundaries; metadata decoding, projection and retirement remain real.
      const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => ({
        ...response,
        data: String(url).includes('/v2/sessions/') ? { session: raw } : {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        },
      }));
      const patch = vi.spyOn(axios, 'patch').mockRejectedValue(new Error('unexpected_projection_write'));
      try {
        const retire = () => retireExactTerminalControlServiceability({
          credentials: { token: 'test-token', encryption: null },
          sessionId, attachmentId: handle.attachmentId, terminalMode: 'tmux',
        });
        await expect(retire()).resolves.toBe('superseded');
        const hostAdapter = adapter({ paneAlive: false, paneDead: true, observedAt: 1 });
        await expect(superviseDisconnectedTerminalHostCandidate({
          candidate: { sessionId, trackingKey: legacyPidSessionTrackingKey(42), pid: 42, happyHomeDir: homeDir, attachmentId: handle.attachmentId, handle },
          terminalHostAdapters: { tmux: hostAdapter },
          retireExactTerminalControlServiceability: retire,
        })).resolves.toEqual({ state: 'stopped' });
        expect(await readTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId })).toBeNull();
        expect(hostAdapter.dispose).not.toHaveBeenCalled();
        expect(raw.metadata).toBe(metadata);
        expect(patch).not.toHaveBeenCalled();
      } finally {
        get.mockRestore();
        patch.mockRestore();
      }
    });
  });

  it('fails closed for attachment mismatch and inconclusive liveness', async () => {
    const hostAdapter = adapter({ paneAlive: false, probeInconclusive: true, observedAt: 1 });
    const changed = { ...attachment(), attachmentId: 'changed' as typeof handle.attachmentId };
    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: { sessionId: 'session-live-1', trackingKey: legacyPidSessionTrackingKey(42), pid: 42, happyHomeDir: '/tmp/happy', attachmentId: handle.attachmentId, handle },
      terminalHostAdapters: { tmux: hostAdapter },
      readTerminalAttachmentInfo: async () => changed,
    })).resolves.toEqual({ state: 'unknown', reason: 'attachment_changed' });
    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: { sessionId: 'session-live-1', trackingKey: legacyPidSessionTrackingKey(42), pid: 42, happyHomeDir: '/tmp/happy', attachmentId: handle.attachmentId, handle },
      terminalHostAdapters: { tmux: hostAdapter },
      readTerminalAttachmentInfo: async () => attachment(),
    })).resolves.toEqual({ state: 'unknown', reason: 'probe_inconclusive' });
  });
});
