import { describe, expect, it, vi } from 'vitest';
import * as tmp from 'tmp';

import type { TerminalHostAdapter, TerminalHostHandle } from '@happier-dev/agents';
import {
  readTerminalHostAttachmentInfo,
  writeTerminalHostAttachmentInfo,
} from './terminalAttachmentInfo';
import {
  executeConfirmedDeadTerminalHostAttachmentRetirement,
  executeTerminalHostDisposition,
  resolveRuntimeTerminalHostDispositionIntent,
} from './terminalHostDisposition';

const HANDLE: TerminalHostHandle = {
  attachmentId: 'attachment-current' as TerminalHostHandle['attachmentId'],
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
};

function buildAdapter(dispose: TerminalHostAdapter['dispose']): TerminalHostAdapter {
  return {
    kind: 'tmux',
    createOrAttachHost: async () => HANDLE,
    injectUserPrompt: async () => ({
      status: 'injected',
      injectedAt: 1,
      bytesWritten: 1,
      hostKind: HANDLE.kind,
      hostSessionName: HANDLE.sessionName,
      paneId: HANDLE.paneId,
    }),
    interruptTurn: async () => undefined,
    evaluateLiveness: async () => ({ paneAlive: true, observedAt: 1 }),
    dispose,
  };
}

describe('executeTerminalHostDisposition', () => {
  it('maps runtime disposal provenance without granting destruction to unknown or recovery paths', () => {
    expect(resolveRuntimeTerminalHostDispositionIntent({ kind: 'destroy_owned_host', reason: 'session_closed' }))
      .toEqual({ kind: 'destroy_owned_host', reason: 'session_closed' });
    expect(resolveRuntimeTerminalHostDispositionIntent({ kind: 'preserve_host', reason: 'plugin_deactivated' }))
      .toEqual({ kind: 'preserve_host', reason: 'planned_runner_refresh', runtimePhase: 'transfer_pending' });
    expect(resolveRuntimeTerminalHostDispositionIntent({ kind: 'preserve_host', reason: 'runtime_recovery' }))
      .toEqual({ kind: 'preserve_host', reason: 'controller_failure', runtimePhase: 'transfer_pending' });
    expect(resolveRuntimeTerminalHostDispositionIntent({ kind: 'preserve_host', reason: 'unspecified' }))
      .toEqual({ kind: 'preserve_host', reason: 'wrapper_exit', runtimePhase: 'transfer_pending' });
  });

  it('parks a stale destroy intent without touching the replacement host', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await writeTerminalHostAttachmentInfo({ happyHomeDir: dir.name, sessionId: 'session-1', handle: HANDLE });
      const dispose = vi.fn(async () => undefined);

      await expect(executeTerminalHostDisposition({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        expectedAttachmentId: 'attachment-stale',
        intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
        adapter: buildAdapter(dispose),
      })).resolves.toMatchObject({ status: 'parked', reason: 'attachment_mismatch' });
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      dir.removeCallback();
    }
  });

  it('keeps physical destruction final when descriptor removal loses a replacement race', async () => {
    const attachment = {
      version: 2 as const,
      attachmentId: HANDLE.attachmentId!,
      sessionId: 'session-removal-race',
      handle: { ...HANDLE, attachmentId: HANDLE.attachmentId! },
      updatedAt: 1,
    };
    const dispose = vi.fn(async () => undefined);
    await expect(executeTerminalHostDisposition({
      happyHomeDir: '/tmp/happy',
      sessionId: 'session-removal-race',
      expectedAttachmentId: HANDLE.attachmentId!,
      intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
      adapter: buildAdapter(dispose),
      readAttachmentInfo: vi.fn(async () => attachment),
      removeAttachmentInfo: vi.fn(async () => false),
    })).resolves.toEqual({ status: 'destroyed', attachmentId: HANDLE.attachmentId, descriptorRetained: true });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps physical destruction final when descriptor removal cannot safely complete', async () => {
    const attachment = {
      version: 2 as const,
      attachmentId: HANDLE.attachmentId!,
      sessionId: 'session-removal-failure',
      handle: { ...HANDLE, attachmentId: HANDLE.attachmentId! },
      updatedAt: 1,
    };
    const dispose = vi.fn(async () => undefined);
    await expect(executeTerminalHostDisposition({
      happyHomeDir: '/tmp/happy',
      sessionId: attachment.sessionId,
      expectedAttachmentId: attachment.attachmentId,
      intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
      adapter: buildAdapter(dispose),
      readAttachmentInfo: vi.fn(async () => attachment),
      removeAttachmentInfo: vi.fn(async () => {
        throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      }),
    })).resolves.toEqual({
      status: 'destroyed',
      attachmentId: attachment.attachmentId,
      descriptorRetained: true,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('retires remote ownership evidence before removing the local descriptor', async () => {
    const events: string[] = [];
    const attachment = {
      version: 2 as const,
      attachmentId: HANDLE.attachmentId!,
      sessionId: 'session-retirement-order',
      handle: { ...HANDLE, attachmentId: HANDLE.attachmentId! },
      updatedAt: 1,
    };
    await expect(executeTerminalHostDisposition({
      happyHomeDir: '/tmp/happy',
      sessionId: attachment.sessionId,
      expectedAttachmentId: attachment.attachmentId,
      intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
      adapter: buildAdapter(async () => {
        events.push('destroy');
      }),
      readAttachmentInfo: vi.fn(async () => attachment),
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
    const attachment = {
      version: 2 as const,
      attachmentId: HANDLE.attachmentId!,
      sessionId: 'session-retirement-failure',
      handle: { ...HANDLE, attachmentId: HANDLE.attachmentId! },
      updatedAt: 1,
    };
    const removeAttachmentInfo = vi.fn(async () => true);
    await expect(executeTerminalHostDisposition({
      happyHomeDir: '/tmp/happy',
      sessionId: attachment.sessionId,
      expectedAttachmentId: attachment.attachmentId,
      intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
      adapter: buildAdapter(async () => undefined),
      readAttachmentInfo: vi.fn(async () => attachment),
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

  it('claims explicit stop once, destroys the exact persisted handle, and removes it by id', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const attachment = await writeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        handle: HANDLE,
      });
      const dispose = vi.fn(async () => undefined);
      const input = {
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        expectedAttachmentId: attachment.attachmentId,
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
      await expect(readTerminalHostAttachmentInfo({ happyHomeDir: dir.name, sessionId: 'session-1' }))
        .resolves.toBeNull();
    } finally {
      dir.removeCallback();
    }
  });

  it('parks a shared attachment without an exact pane target', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const attachment = await writeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        handle: { ...HANDLE, paneId: undefined },
      });
      const dispose = vi.fn(async () => undefined);

      await expect(executeTerminalHostDisposition({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        expectedAttachmentId: attachment.attachmentId,
        intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
        adapter: buildAdapter(dispose),
      })).resolves.toMatchObject({ status: 'parked', reason: 'missing_topology_proof' });
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      dir.removeCallback();
    }
  });

  it('retires an unchanged legacy host descriptor after positive death proof', async () => {
    const legacy = {
      version: 1 as const,
      sessionId: 'session-legacy-dead',
      handle: { ...HANDLE, attachmentId: undefined },
      updatedAt: 1,
    };
    const removeAttachmentInfo = vi.fn(async () => true);

    await expect(executeConfirmedDeadTerminalHostAttachmentRetirement({
      happyHomeDir: '/tmp/happy',
      sessionId: legacy.sessionId,
      expectedAttachmentInfo: legacy,
      readAttachmentInfo: vi.fn(async () => legacy),
      removeAttachmentInfo,
    })).resolves.toEqual({ status: 'retired', attachmentId: null });
    expect(removeAttachmentInfo).toHaveBeenCalledWith({
      happyHomeDir: '/tmp/happy',
      sessionId: legacy.sessionId,
      expectedHandle: legacy.handle,
    });
  });
});
