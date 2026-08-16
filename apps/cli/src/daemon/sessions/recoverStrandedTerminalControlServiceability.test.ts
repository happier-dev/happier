import { describe, expect, it, vi } from 'vitest';

import type { TerminalHostAdapter } from '@/integrations/terminalHost/_types';
import type { Credentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

import { recoverStrandedTerminalControlServiceability } from './recoverStrandedTerminalControlServiceability';

const credentials: Credentials = {
  token: 'token',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
};

function createAdapter(
  evaluateLiveness: TerminalHostAdapter['evaluateLiveness'],
): TerminalHostAdapter {
  return {
    kind: 'tmux',
    createOrAttachHost: async () => {
      throw new Error('not used');
    },
    injectUserPrompt: async () => ({ status: 'injected', at: 1, bytesWritten: 1 }),
    interruptTurn: async () => undefined,
    evaluateLiveness,
    dispose: async () => undefined,
  };
}

function createRawSession(metadata: Record<string, unknown>) {
  return createSessionRecordFixture({
    id: 'session-1',
    encryptionMode: 'plain',
    metadata: JSON.stringify(metadata),
  });
}

function createMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    machineId: 'machine-current',
    terminal: {
      mode: 'tmux',
      tmux: { target: 'happy-session:owned-pane' },
      controlServiceabilityV1: {
        v: 1,
        attachmentId: 'attachment-1',
        state: 'recoverable_unservable',
        observedAt: 100,
        reason: 'runner_absent',
      },
    },
    ...overrides,
  };
}

describe('recoverStrandedTerminalControlServiceability', () => {
  it('retires exact stranded serviceability only after the canonical host probe proves death', async () => {
    const evaluateLiveness = vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 200 }));
    const retireExactTerminalControlServiceability = vi.fn(async () => 'retired' as const);

    await expect(recoverStrandedTerminalControlServiceability({
      credentials,
      currentMachineId: 'machine-current',
      happyHomeDir: '/happy-home',
      sessionId: 'session-1',
      loadTerminalHostAdapters: async () => ({ tmux: createAdapter(evaluateLiveness) }),
      fetchSession: async () => createRawSession(createMetadata()),
      retireExactTerminalControlServiceability,
    })).resolves.toEqual({ status: 'stopped' });

    expect(evaluateLiveness).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tmux',
      sessionName: 'happy-session',
      paneId: 'owned-pane',
    }));
    expect(retireExactTerminalControlServiceability).toHaveBeenCalledWith({
      sessionId: 'session-1',
      attachmentId: 'attachment-1',
      terminalMode: 'tmux',
    });
  });

  it('fails closed when the exact host is alive or its probe is inconclusive', async () => {
    const retire = vi.fn(async () => 'retired' as const);
    const run = async (evaluateLiveness: TerminalHostAdapter['evaluateLiveness']) => await recoverStrandedTerminalControlServiceability({
      credentials,
      currentMachineId: 'machine-current',
      happyHomeDir: '/happy-home',
      sessionId: 'session-1',
      loadTerminalHostAdapters: async () => ({ tmux: createAdapter(evaluateLiveness) }),
      fetchSession: async () => createRawSession(createMetadata()),
      retireExactTerminalControlServiceability: retire,
    });

    await expect(run(async () => ({ paneAlive: true, observedAt: 200 })))
      .resolves.toEqual({ status: 'incomplete', reason: 'tracked_runner_absent' });
    await expect(run(async () => ({ paneAlive: false, probeInconclusive: true, observedAt: 201 })))
      .resolves.toEqual({ status: 'incomplete', reason: 'missing_topology_proof' });
    expect(retire).not.toHaveBeenCalled();
  });

  it('does not probe or retire remote, retired, replacement, or unserviceable evidence', async () => {
    const evaluateLiveness = vi.fn(async () => ({ paneAlive: false, observedAt: 200 }));
    const retire = vi.fn(async () => 'retired' as const);
    const cases = [
      createMetadata({ machineId: 'machine-other' }),
      createMetadata({ terminal: {
        mode: 'tmux',
        tmux: { target: 'happy-session:owned-pane' },
        controlServiceabilityV1: { v: 1, attachmentId: 'attachment-1', state: 'unknown', observedAt: 100 },
      } }),
      createMetadata({ terminal: {
        mode: 'tmux',
        tmux: { target: 'happy-session:owned-pane' },
        controlServiceabilityV1: { v: 1, attachmentId: 'attachment-1', state: 'unknown', observedAt: 100, retired: true },
      } }),
      createMetadata({ terminal: {
        mode: 'plain',
        controlServiceabilityV1: { v: 1, attachmentId: 'attachment-1', state: 'recoverable_unservable', observedAt: 100 },
      } }),
    ];

    for (const metadata of cases) {
      await expect(recoverStrandedTerminalControlServiceability({
        credentials,
        currentMachineId: 'machine-current',
        happyHomeDir: '/happy-home',
        sessionId: 'session-1',
        loadTerminalHostAdapters: async () => ({ tmux: createAdapter(evaluateLiveness) }),
        fetchSession: async () => createRawSession(metadata),
        retireExactTerminalControlServiceability: retire,
      })).resolves.toBeNull();
    }
    expect(evaluateLiveness).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
  });

  it('does not claim success when a replacement wins the exact retirement fence', async () => {
    await expect(recoverStrandedTerminalControlServiceability({
      credentials,
      currentMachineId: 'machine-current',
      happyHomeDir: '/happy-home',
      sessionId: 'session-1',
      loadTerminalHostAdapters: async () => ({
        tmux: createAdapter(async () => ({ paneAlive: false, observedAt: 200 })),
      }),
      fetchSession: async () => createRawSession(createMetadata()),
      retireExactTerminalControlServiceability: async () => 'superseded',
    })).resolves.toEqual({ status: 'incomplete', reason: 'attachment_mismatch' });
  });

  it('reproves a pinned dead host so local cleanup can retry after server retirement', async () => {
    const evaluateLiveness = vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 200 }));
    const retireExactTerminalControlServiceability = vi.fn(async () => 'retired' as const);
    const retiredMetadata = createMetadata({
      terminal: {
        mode: 'tmux',
        tmux: { target: 'happy-session:owned-pane' },
        controlServiceabilityV1: {
          v: 1,
          attachmentId: 'attachment-1',
          state: 'recoverable_unservable',
          observedAt: 100,
          retired: true,
        },
      },
    });

    await expect(recoverStrandedTerminalControlServiceability({
      credentials,
      currentMachineId: 'machine-current',
      happyHomeDir: '/happy-home',
      sessionId: 'session-1',
      expectedAttachmentId: 'attachment-1',
      loadTerminalHostAdapters: async () => ({ tmux: createAdapter(evaluateLiveness) }),
      fetchSession: async () => createRawSession(retiredMetadata),
      retireExactTerminalControlServiceability,
    })).resolves.toEqual({ status: 'stopped' });
    expect(evaluateLiveness).toHaveBeenCalledOnce();
    expect(retireExactTerminalControlServiceability).not.toHaveBeenCalled();
  });

  it('does not probe or retire serviceability for a replacement attachment', async () => {
    const evaluateLiveness = vi.fn(async () => ({ paneAlive: false, observedAt: 200 }));
    const retireExactTerminalControlServiceability = vi.fn(async () => 'retired' as const);
    const request = {
      credentials,
      currentMachineId: 'machine-current',
      happyHomeDir: '/happy-home',
      sessionId: 'session-1',
      expectedAttachmentId: 'attachment-local',
      loadTerminalHostAdapters: async () => ({ tmux: createAdapter(evaluateLiveness) }),
      fetchSession: async () => createRawSession(createMetadata()),
      retireExactTerminalControlServiceability,
    };

    await expect(recoverStrandedTerminalControlServiceability(request))
      .resolves.toEqual({ status: 'incomplete', reason: 'attachment_mismatch' });
    expect(evaluateLiveness).not.toHaveBeenCalled();
    expect(retireExactTerminalControlServiceability).not.toHaveBeenCalled();
  });
});
