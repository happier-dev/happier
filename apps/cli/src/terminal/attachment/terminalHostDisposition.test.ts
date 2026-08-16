import { describe, expect, it, vi } from 'vitest';
import * as tmp from 'tmp';

import type { TerminalAttachmentId, TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';

import {
  readTerminalAttachmentInfo,
  writeTerminalAttachmentInfo,
} from './terminalAttachmentInfo';
import {
  executeConfirmedDeadTerminalAttachmentRetirement,
  executeTerminalHostDisposition,
} from './terminalHostDisposition';

const HANDLE = {
  attachmentId: 'attachment-current' as TerminalAttachmentId,
  kind: 'tmux',
  sessionName: 'happy',
  paneId: 'owned-window',
  socketDir: '/tmp/happier-tmux-root',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    maxClients: null,
    requiresLocalAttachmentInfo: true,
    liveProbe: 'required',
  },
} satisfies TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>;

async function persistBoundAttachment(happyHomeDir: string): Promise<void> {
  await writeTerminalAttachmentInfo({
    happyHomeDir,
    sessionId: 'session-1',
    attachmentId: HANDLE.attachmentId,
    handle: HANDLE,
    terminal: {
      mode: 'tmux',
      tmux: { target: 'happy:owned-window', tmpDir: HANDLE.socketDir },
    },
  });
}

function buildAdapter(dispose: TerminalHostAdapter['dispose']): TerminalHostAdapter {
  return {
    kind: 'tmux',
    createOrAttachHost: async () => HANDLE,
    injectUserPrompt: async () => ({ status: 'injected', at: 1, bytesWritten: 1 }),
    interruptTurn: async () => undefined,
    evaluateLiveness: async () => ({ paneAlive: true, observedAt: 1 }),
    dispose,
  };
}

describe('executeTerminalHostDisposition', () => {
  it('preserves the bound host and attachment metadata on planned refresh', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await persistBoundAttachment(dir.name);

      await expect(executeTerminalHostDisposition({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        expectedAttachmentId: HANDLE.attachmentId!,
        intent: {
          kind: 'preserve_host',
          reason: 'planned_runner_refresh',
          runtimePhase: 'transfer_pending',
        },
      })).resolves.toEqual({ status: 'preserved', attachmentId: HANDLE.attachmentId });
      await expect(readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
      })).resolves.toMatchObject({ attachmentId: HANDLE.attachmentId, handle: HANDLE });
    } finally {
      dir.removeCallback();
    }
  });

  it('parks stale destroy intent without touching the replacement host or metadata', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await persistBoundAttachment(dir.name);
      const dispose = vi.fn(async () => undefined);

      await expect(executeTerminalHostDisposition({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        expectedAttachmentId: 'attachment-stale',
        intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
        adapter: buildAdapter(dispose),
      })).resolves.toMatchObject({ status: 'parked', reason: 'attachment_mismatch' });
      expect(dispose).not.toHaveBeenCalled();
      await expect(readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId: 'session-1' }))
        .resolves.toMatchObject({ attachmentId: HANDLE.attachmentId });
    } finally {
      dir.removeCallback();
    }
  });

  it('keeps physical destruction final when descriptor removal loses a replacement race', async () => {
    const dispose = vi.fn(async () => undefined);
    await expect(executeTerminalHostDisposition({
      happyHomeDir: '/tmp/happy',
      sessionId: 'session-removal-race',
      expectedAttachmentId: HANDLE.attachmentId!,
      intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
      adapter: buildAdapter(dispose),
      readAttachmentInfo: vi.fn(async () => ({
        version: 2 as const,
        attachmentId: HANDLE.attachmentId!,
        sessionId: 'session-removal-race',
        handle: { ...HANDLE, attachmentId: HANDLE.attachmentId! },
        terminal: { mode: 'zellij' as const, zellij: { sessionName: HANDLE.sessionName, paneId: HANDLE.paneId!, socketDirV1: HANDLE.socketDir! } },
        updatedAt: 1,
      })),
      removeAttachmentInfo: vi.fn(async () => false),
    })).resolves.toEqual({ status: 'destroyed', attachmentId: HANDLE.attachmentId, descriptorRetained: true });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('retires remote ownership evidence before removing the local descriptor', async () => {
    const events: string[] = [];
    await expect(executeTerminalHostDisposition({
      happyHomeDir: '/tmp/happy',
      sessionId: 'session-retirement-order',
      expectedAttachmentId: HANDLE.attachmentId!,
      intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
      adapter: buildAdapter(async () => {
        events.push('destroy');
      }),
      readAttachmentInfo: vi.fn(async () => ({
        version: 2 as const,
        attachmentId: HANDLE.attachmentId!,
        sessionId: 'session-retirement-order',
        handle: HANDLE,
        terminal: { mode: 'tmux' as const, tmux: { target: 'happy:owned-window' } },
        updatedAt: 1,
      })),
      beforeDescriptorRetirement: async () => {
        events.push('remote');
      },
      removeAttachmentInfo: vi.fn(async () => {
        events.push('local');
        return true;
      }),
    })).resolves.toEqual({ status: 'destroyed', attachmentId: HANDLE.attachmentId });
    expect(events).toEqual(['destroy', 'remote', 'local']);
  });

  it('retains the local descriptor when remote ownership retirement fails after destruction', async () => {
    const removeAttachmentInfo = vi.fn(async () => true);
    await expect(executeTerminalHostDisposition({
      happyHomeDir: '/tmp/happy',
      sessionId: 'session-retirement-failure',
      expectedAttachmentId: HANDLE.attachmentId!,
      intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
      adapter: buildAdapter(async () => undefined),
      readAttachmentInfo: vi.fn(async () => ({
        version: 2 as const,
        attachmentId: HANDLE.attachmentId!,
        sessionId: 'session-retirement-failure',
        handle: HANDLE,
        terminal: { mode: 'tmux' as const, tmux: { target: 'happy:owned-window' } },
        updatedAt: 1,
      })),
      beforeDescriptorRetirement: async () => {
        throw new Error('remote unavailable');
      },
      removeAttachmentInfo,
    })).resolves.toEqual({
      status: 'destroyed',
      attachmentId: HANDLE.attachmentId,
      descriptorRetained: true,
      retirementFailed: true,
    });
    expect(removeAttachmentInfo).not.toHaveBeenCalled();
  });

  it('claims explicit stop once, destroys the persisted handle, and removes by expected-id CAS', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await persistBoundAttachment(dir.name);
      const dispose = vi.fn(async () => undefined);
      const input = {
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        expectedAttachmentId: HANDLE.attachmentId!,
        intent: { kind: 'destroy_owned_host' as const, reason: 'explicit_user_stop' as const },
        adapter: buildAdapter(dispose),
      };

      const results = await Promise.all([
        executeTerminalHostDisposition(input),
        executeTerminalHostDisposition(input),
      ]);

      expect(results.filter((result) => result.status === 'destroyed')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'parked')).toHaveLength(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledWith(expect.objectContaining({
        attachmentId: HANDLE.attachmentId,
        sessionName: 'happy',
        paneId: 'owned-window',
        socketDir: '/tmp/happier-tmux-root',
      }));
      await expect(readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId: 'session-1' }))
        .resolves.toBeNull();
    } finally {
      dir.removeCallback();
    }
  });

  it('retires an exactly bound confirmed-dead attachment without trying to destroy the already-dead host', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await persistBoundAttachment(dir.name);
      const dispose = vi.fn(async () => {
        throw new Error('the confirmed-dead pane cannot be closed');
      });

      await expect(executeTerminalHostDisposition({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        expectedAttachmentId: HANDLE.attachmentId!,
        intent: { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
        adapter: buildAdapter(dispose),
      })).resolves.toEqual({ status: 'retired', attachmentId: HANDLE.attachmentId });

      expect(dispose).not.toHaveBeenCalled();
      await expect(readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId: 'session-1' }))
        .resolves.toBeNull();
    } finally {
      dir.removeCallback();
    }
  });

  it('parks legacy and shared missing-pane attachments without physical destruction', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'legacy-session',
        terminal: { mode: 'tmux', tmux: { target: 'happy' } },
      });
      const dispose = vi.fn(async () => undefined);

      await expect(executeTerminalHostDisposition({
        happyHomeDir: dir.name,
        sessionId: 'legacy-session',
        expectedAttachmentId: 'attachment-guessed',
        intent: { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
        adapter: buildAdapter(dispose),
      })).resolves.toMatchObject({ status: 'parked', reason: 'legacy_attachment' });
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      dir.removeCallback();
    }
  });

  it('retires an unchanged legacy attachment after its host was positively proven dead', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'legacy-dead-session',
        terminal: {
          mode: 'tmux',
          tmux: { target: 'happy:legacy-window', tmpDir: '/tmp/happier-tmux' },
        },
      });
      const attachmentInfo = await readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'legacy-dead-session',
      });
      if (!attachmentInfo || attachmentInfo.version !== 1) {
        throw new Error('Expected a legacy attachment fixture');
      }
      await expect(executeConfirmedDeadTerminalAttachmentRetirement({
        happyHomeDir: dir.name,
        sessionId: 'legacy-dead-session',
        expectedAttachmentInfo: attachmentInfo,
      })).resolves.toEqual({ status: 'retired', attachmentId: null });

      await expect(readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'legacy-dead-session',
      })).resolves.toBeNull();
    } finally {
      dir.removeCallback();
    }
  });
});
