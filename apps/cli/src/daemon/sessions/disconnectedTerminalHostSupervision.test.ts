import { describe, expect, it, vi } from 'vitest';
import type { TerminalHostAdapter, TerminalHostHandle } from '@happier-dev/agents';

import {
  resolveDisconnectedTerminalHostResumeGate,
  superviseDisconnectedTerminalHostCandidate,
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
    const removeAttachment = vi.fn(async () => true);
    const removeMarker = vi.fn(async () => undefined);
    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: { sessionId: 'session-live-1', pid: 42, happyHomeDir: '/tmp/happy', attachmentId: handle.attachmentId, handle },
      terminalHostAdapters: { tmux: hostAdapter },
      readTerminalAttachmentInfo: async () => attachment(),
      removeTerminalAttachmentInfo: removeAttachment,
      removeSessionMarker: removeMarker,
      onExactTerminalAttachmentRetired: async () => undefined,
    })).resolves.toEqual({ state: 'stopped' });
    expect(removeAttachment).toHaveBeenCalled();
    expect(removeMarker).toHaveBeenCalledWith(42);
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
