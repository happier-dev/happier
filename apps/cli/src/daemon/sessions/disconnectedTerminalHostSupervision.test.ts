import { describe, expect, it, vi } from 'vitest';
import type { TerminalHostAdapter, TerminalHostHandle } from '@happier-dev/agents';
import axios, { AxiosHeaders } from 'axios';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';

import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { readTerminalHostAttachmentInfo, writeTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { retireExactTerminalControlServiceability } from './retireTerminalControlServiceability';

import {
  resolveDisconnectedTerminalMode,
  resolveDisconnectedTerminalHostResumeGate,
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
            tracked: { pid: process.pid, startedBy: 'daemon', happySessionId: sessionId },
            happyHomeDir: homeDir, isCurrent: () => true,
            loadTerminalHostAdapters: async () => { throw new Error('Borrowed client retirement must not dispose the shell'); },
            probeSessionServiceability: async () => { throw new Error('Native death is not controller death'); },
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
      hostKind: 'windows_console',
      attachmentId: 'attachment-windows',
    })).toBe('windows_terminal');
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
      hostKind: 'windows_console',
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
      candidate: { sessionId: 'session-live-1', pid: 42, happyHomeDir: '/tmp/happy', attachmentId: handle.attachmentId, handle, controlDescriptorAvailable: false },
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
    const removeMarker = vi.fn(async (_pid: number) => undefined);
    const events: string[] = [];
    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: { sessionId: 'session-live-1', pid: 42, happyHomeDir: '/tmp/happy', attachmentId: handle.attachmentId, handle },
      terminalHostAdapters: { tmux: hostAdapter },
      readTerminalAttachmentInfo: async () => attachment(),
      removeTerminalAttachmentInfo: async (input) => {
        events.push('local');
        return await removeAttachment(input);
      },
      removeSessionMarker: async (pid) => {
        events.push('marker');
        await removeMarker(pid);
      },
      retireExactTerminalControlServiceability: async () => {
        events.push('remote');
      },
    })).resolves.toEqual({ state: 'stopped' });
    expect(removeAttachment).toHaveBeenCalled();
    expect(removeMarker).toHaveBeenCalledWith(42);
    expect(events).toEqual(['remote', 'local', 'marker']);
  });

  it('keeps local retry identity when confirmed-dead remote retirement fails', async () => {
    const removeAttachment = vi.fn(async (_input: unknown) => true);
    const removeMarker = vi.fn(async (_pid: number) => undefined);
    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: { sessionId: 'session-live-1', pid: 42, happyHomeDir: '/tmp/happy', attachmentId: handle.attachmentId, handle },
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
          candidate: { sessionId, pid: 42, happyHomeDir: homeDir, attachmentId: handle.attachmentId, handle },
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
      candidate: { sessionId: 'session-live-1', pid: 42, happyHomeDir: '/tmp/happy', attachmentId: handle.attachmentId, handle },
      terminalHostAdapters: { tmux: hostAdapter },
      readTerminalAttachmentInfo: async () => changed,
    })).resolves.toEqual({ state: 'unknown', reason: 'attachment_changed' });
    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: { sessionId: 'session-live-1', pid: 42, happyHomeDir: '/tmp/happy', attachmentId: handle.attachmentId, handle },
      terminalHostAdapters: { tmux: hostAdapter },
      readTerminalAttachmentInfo: async () => attachment(),
    })).resolves.toEqual({ state: 'unknown', reason: 'probe_inconclusive' });
  });
});
