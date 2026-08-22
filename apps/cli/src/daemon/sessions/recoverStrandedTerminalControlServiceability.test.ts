import { describe, expect, it, vi } from 'vitest';
import type { TerminalHostAdapter } from '@happier-dev/agents';

import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

import { recoverStrandedTerminalControlServiceability } from './recoverStrandedTerminalControlServiceability';

function adapter(evaluateLiveness: TerminalHostAdapter['evaluateLiveness']): TerminalHostAdapter {
  return {
    kind: 'tmux',
    createOrAttachHost: vi.fn(),
    injectUserPrompt: vi.fn(),
    interruptTurn: vi.fn(),
    evaluateLiveness,
    dispose: vi.fn(),
  };
}

function metadata(machineId = 'machine-current'): Record<string, unknown> {
  return {
    machineId,
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
  };
}

function params(input: Readonly<{
  evaluateLiveness: TerminalHostAdapter['evaluateLiveness'];
  metadata?: Record<string, unknown>;
  retire?: () => Promise<'retired' | 'superseded'>;
  expectedAttachmentId?: string;
}>) {
  return {
    credentials: { token: 'token', encryption: null },
    currentMachineId: 'machine-current',
    sessionId: 'session-1',
    ...(input.expectedAttachmentId ? { expectedAttachmentId: input.expectedAttachmentId } : {}),
    loadTerminalHostAdapters: async () => ({ tmux: adapter(input.evaluateLiveness) }),
    fetchSession: async () => createSessionRecordFixture({
      id: 'session-1',
      encryptionMode: 'plain',
      metadataLayoutVersion: 0,
      metadata: JSON.stringify(input.metadata ?? metadata()),
    }),
    resolveAccountEncryptionMode: async () => 'plain' as const,
    retireExactTerminalControlServiceability: vi.fn(input.retire ?? (async () => 'retired' as const)),
  };
}

describe('recoverStrandedTerminalControlServiceability', () => {
  it('retires exact stranded serviceability only after the canonical host probe proves death', async () => {
    const input = params({ evaluateLiveness: async () => ({ paneAlive: false, paneDead: true, observedAt: 200 }) });
    await expect(recoverStrandedTerminalControlServiceability(input)).resolves.toEqual({ status: 'stopped' });
    expect(input.retireExactTerminalControlServiceability).toHaveBeenCalledWith({
      sessionId: 'session-1',
      attachmentId: 'attachment-1',
      terminalMode: 'tmux',
    });
  });

  it('fails closed for alive, inconclusive, remote, or superseded terminal evidence', async () => {
    await expect(recoverStrandedTerminalControlServiceability(params({
      evaluateLiveness: async () => ({ paneAlive: true, observedAt: 200 }),
    }))).resolves.toEqual({ status: 'incomplete', reason: 'tracked_runner_absent' });
    await expect(recoverStrandedTerminalControlServiceability(params({
      evaluateLiveness: async () => ({ paneAlive: false, probeInconclusive: true, observedAt: 200 }),
    }))).resolves.toEqual({ status: 'incomplete', reason: 'missing_topology_proof' });
    await expect(recoverStrandedTerminalControlServiceability(params({
      evaluateLiveness: async () => ({ paneAlive: false, paneDead: true, observedAt: 200 }),
      metadata: metadata('machine-other'),
    }))).resolves.toBeNull();
    await expect(recoverStrandedTerminalControlServiceability(params({
      evaluateLiveness: async () => ({ paneAlive: false, paneDead: true, observedAt: 200 }),
      retire: async () => 'superseded',
    }))).resolves.toEqual({ status: 'incomplete', reason: 'attachment_mismatch' });
  });

  it('does not manufacture a probe identity for current Dev zellij or Windows metadata', async () => {
    for (const terminal of [
      { mode: 'zellij' },
      { mode: 'windows_console', windows: { host: 'console' } },
    ]) {
      await expect(recoverStrandedTerminalControlServiceability(params({
        evaluateLiveness: async () => ({ paneAlive: false, paneDead: true, observedAt: 200 }),
        metadata: {
          machineId: 'machine-current',
          terminal: {
            ...terminal,
            controlServiceabilityV1: {
              v: 1,
              attachmentId: 'attachment-1',
              state: 'recoverable_unservable',
              observedAt: 100,
            },
          },
        },
      }))).resolves.toEqual({ status: 'incomplete', reason: 'missing_topology_proof' });
    }
  });

  it('reproves a pinned dead host so local cleanup can retry after server retirement', async () => {
    const retiredMetadata = metadata();
    const terminal = retiredMetadata.terminal as { controlServiceabilityV1: Record<string, unknown> };
    terminal.controlServiceabilityV1.retired = true;
    const input = params({
      evaluateLiveness: async () => ({ paneAlive: false, paneDead: true, observedAt: 200 }),
      metadata: retiredMetadata,
      expectedAttachmentId: 'attachment-1',
    });

    await expect(recoverStrandedTerminalControlServiceability(input))
      .resolves.toEqual({ status: 'stopped' });
    expect(input.retireExactTerminalControlServiceability).not.toHaveBeenCalled();
  });

  it('does not probe or retire a replacement attachment', async () => {
    const evaluateLiveness = vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 200 }));
    const input = params({ evaluateLiveness, expectedAttachmentId: 'attachment-local' });

    await expect(recoverStrandedTerminalControlServiceability(input))
      .resolves.toEqual({ status: 'incomplete', reason: 'attachment_mismatch' });
    expect(evaluateLiveness).not.toHaveBeenCalled();
    expect(input.retireExactTerminalControlServiceability).not.toHaveBeenCalled();
  });
});
