import { describe, expect, it, vi } from 'vitest';
import * as tmp from 'tmp';
import { chmod, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TerminalHostAdapter, TerminalHostHandle } from '@happier-dev/agents';
import { createSessionHooksService } from '@/plugins/runtime/hooks/session/service';
import { logger } from '@/ui/logger';
import {
  readTerminalHostAttachmentInfo,
  removeTerminalHostAttachmentInfo,
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
    evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
    dispose,
  };
}

describe('executeTerminalHostDisposition', () => {
  it.each(['read', 'destroy', 'retirement', 'descriptor_retirement'] as const)(
    'retains the native cause when exact host %s fails', async phase => {
      const dir = tmp.dirSync({ unsafeCleanup: true });
      const sessionId = `cause-${phase}`;
      const error = Object.assign(new Error('private native details'), { code: 'EACCES' });
      try {
        const attachment = await writeTerminalHostAttachmentInfo({ happyHomeDir: dir.name, sessionId, handle: HANDLE });
        const result = await executeTerminalHostDisposition({ happyHomeDir: dir.name, sessionId,
          expectedAttachmentId: attachment.attachmentId,
          intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
          adapter: buildAdapter(async () => { if (phase === 'destroy') throw error; }),
          ...(phase === 'read' ? { readAttachmentState: async () => { throw error; } } : {}),
          ...(phase === 'retirement' ? { beforeDescriptorRetirement: async () => { throw error; } } : {}),
          ...(phase === 'descriptor_retirement' ? { removeAttachmentInfo: async () => { throw error; } } : {}),
        });
        expect(result).toMatchObject({ status: phase === 'read' || phase === 'destroy' ? 'parked' : 'destroyed',
          failureCause: { phase: `terminal_host.disposition.${phase}`, errorClass: 'Error', errorCode: 'EACCES', httpStatus: null } });
        expect(await readTerminalHostAttachmentInfo({ happyHomeDir: dir.name, sessionId })).not.toBeNull();
      } finally { dir.removeCallback(); }
    });

  it.each(['owned', 'borrowed'] as const)('retires captured %s attachment evidence after the exited runner removed its descriptor', async (lifecycle) => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    const sessionId = `session-exited-${lifecycle}`;
    try {
      const attachment = await writeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        handle: HANDLE,
        ...(lifecycle === 'borrowed' ? { lifecycle: 'borrowed' as const } : {}),
      });
      await removeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        expectedAttachmentId: attachment.attachmentId,
      });
      const events: string[] = [];
      const input = {
        happyHomeDir: dir.name,
        sessionId,
        expectedAttachmentId: attachment.attachmentId,
        expectedAttachmentInfo: attachment,
        intent: lifecycle === 'borrowed'
          ? { kind: 'release_borrowed_host' as const, reason: 'explicit_user_stop' as const }
          : { kind: 'destroy_owned_host' as const, reason: 'explicit_user_stop' as const },
        adapter: buildAdapter(async () => { events.push('dispose'); }),
        beforeDescriptorRetirement: async () => { events.push('retire'); },
      };

      await expect(executeTerminalHostDisposition(input)).resolves.toEqual({
        status: lifecycle === 'borrowed' ? 'retired' : 'destroyed',
        attachmentId: attachment.attachmentId,
      });
      expect(events).toEqual(lifecycle === 'borrowed' ? ['retire'] : ['dispose', 'retire']);
      await expect(readTerminalHostAttachmentInfo({ happyHomeDir: dir.name, sessionId })).resolves.toBeNull();
    } finally {
      dir.removeCallback();
    }
  });

  it.each([
    { lifecycle: 'owned', path: 'host' },
    { lifecycle: 'borrowed', path: 'host' },
    { lifecycle: 'owned', path: 'predecessor' },
    { lifecycle: 'borrowed', path: 'predecessor' },
  ] as const)('does not substitute captured $lifecycle evidence for an unreadable $path descriptor', async ({ lifecycle, path }) => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    const sessionId = 'session-unreadable-after-exit';
    try {
      const attachment = await writeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        handle: HANDLE,
        ...(lifecycle === 'borrowed' ? { lifecycle } : {}),
      });
      // Real persistent-filesystem boundary: malformed evidence is not absence.
      const descriptorPath = join(dir.name, 'terminal', 'sessions', `${sessionId}.${path === 'host' ? 'host.json' : 'json'}`);
      if (path === 'predecessor') {
        await unlink(join(dir.name, 'terminal', 'sessions', `${sessionId}.host.json`));
      }
      await writeFile(descriptorPath, '{');
      const dispose = vi.fn(async () => undefined);
      const retire = vi.fn(async () => undefined);
      const input = {
        happyHomeDir: dir.name,
        sessionId,
        expectedAttachmentId: attachment.attachmentId,
        expectedAttachmentInfo: attachment,
        intent: lifecycle === 'borrowed'
          ? { kind: 'release_borrowed_host' as const, reason: 'explicit_user_stop' as const }
          : { kind: 'destroy_owned_host' as const, reason: 'explicit_user_stop' as const },
        adapter: buildAdapter(dispose),
        beforeDescriptorRetirement: retire,
      };
      await expect(executeTerminalHostDisposition(input)).resolves.toEqual({ status: 'parked', reason: 'missing_topology_proof',
        failureCause: { phase: 'terminal_host.disposition.read', errorClass: 'Error', errorCode: null, httpStatus: null } });
      expect(dispose).not.toHaveBeenCalled();
      expect(retire).not.toHaveBeenCalled();
      await expect(stat(descriptorPath)).resolves.toBeDefined();
    } finally {
      dir.removeCallback();
    }
  });

  it.each(['borrowed', 'owned'] as const)('preserves $lifecycle disposition finality when the descriptor becomes unreadable during upstream retirement', async (lifecycle) => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    const sessionId = 'session-borrowed-retirement-unreadable';
    try {
      const attachment = await writeTerminalHostAttachmentInfo({ happyHomeDir: dir.name, sessionId, handle: HANDLE, lifecycle });
      await expect(executeTerminalHostDisposition({
        happyHomeDir: dir.name,
        sessionId,
        expectedAttachmentId: attachment.attachmentId,
        expectedAttachmentInfo: attachment,
        intent: lifecycle === 'borrowed'
          ? { kind: 'release_borrowed_host', reason: 'explicit_user_stop' }
          : { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
        adapter: buildAdapter(async () => undefined),
        beforeDescriptorRetirement: async () => {
          await writeFile(join(dir.name, 'terminal', 'sessions', `${sessionId}.host.json`), '{');
        },
      })).resolves.toMatchObject(lifecycle === 'borrowed'
        ? { status: 'parked', reason: 'missing_topology_proof' }
        : { status: 'destroyed', attachmentId: attachment.attachmentId, descriptorRetained: true });
      await expect(stat(join(dir.name, 'terminal', 'sessions', `${sessionId}.host.json`))).resolves.toBeDefined();
    } finally {
      dir.removeCallback();
    }
  });

  it('releases a borrowed descriptor without disposing the user-owned pane', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    const sessionId = 'session-borrowed';
    try {
      const attachment = await writeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        handle: HANDLE,
        lifecycle: 'borrowed',
      });
      // Releasing a borrowed host needs no host adapter or destructive capability.
      await expect(executeTerminalHostDisposition({
        happyHomeDir: dir.name,
        sessionId,
        expectedAttachmentId: attachment.attachmentId,
        intent: { kind: 'release_borrowed_host', reason: 'explicit_user_stop' },
      })).resolves.toEqual({ status: 'retired', attachmentId: attachment.attachmentId });
      await expect(readTerminalHostAttachmentInfo({ happyHomeDir: dir.name, sessionId })).resolves.toBeNull();
    } finally {
      dir.removeCallback();
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each(['borrowed', 'dead', 'owned'] as const)(
    'retains exact %s evidence and returns a typed result when filesystem retirement fails', async (lifecycle) => {
      const dir = tmp.dirSync({ unsafeCleanup: true });
      const sessionId = `session-removal-denied-${lifecycle}`;
      const sessionsDir = join(dir.name, 'terminal', 'sessions');
      const dispose = vi.fn(async () => undefined);
      // Observe the real default logging sink; do not replace its implementation.
      const fileLog = vi.spyOn(logger, 'infoFile');
      try {
        const attachment = await writeTerminalHostAttachmentInfo({
          happyHomeDir: dir.name, sessionId, handle: HANDLE,
          ...(lifecycle === 'borrowed' ? { lifecycle } : {}),
        });
        await expect(executeTerminalHostDisposition({
          happyHomeDir: dir.name, sessionId, expectedAttachmentId: attachment.attachmentId,
          intent: lifecycle === 'borrowed'
            ? { kind: 'release_borrowed_host', reason: 'explicit_user_stop' }
            : lifecycle === 'owned'
              ? { kind: 'destroy_owned_host', reason: 'explicit_user_stop' }
            : { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
          adapter: buildAdapter(dispose),
          // Genuine OS permission failure: retain a readable exact descriptor,
          // but deny the canonical remover's filesystem writes.
          beforeDescriptorRetirement: async () => { await chmod(sessionsDir, 0o500); },
        })).resolves.toMatchObject(lifecycle === 'owned'
          ? { status: 'destroyed', attachmentId: attachment.attachmentId, descriptorRetained: true }
          : { status: 'parked', reason: 'descriptor_retirement_failed' });
        expect(fileLog).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
          sessionId, attachmentId: attachment.attachmentId,
        }));
        if (lifecycle !== 'owned') expect(dispose).not.toHaveBeenCalled();
        await expect(readTerminalHostAttachmentInfo({ happyHomeDir: dir.name, sessionId })).resolves.toEqual(attachment);
      } finally {
        fileLog.mockRestore();
        await chmod(sessionsDir, 0o700);
        dir.removeCallback();
      }
    },
  );

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
      failureCause: { phase: 'terminal_host.disposition.descriptor_retirement', errorClass: 'Error', errorCode: 'EPERM', httpStatus: null },
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('retires the descriptor when disposal reports failure but the exact host is positively dead', async () => {
    const attachment = {
      version: 2 as const,
      attachmentId: HANDLE.attachmentId!,
      sessionId: 'session-disappeared-during-dispose',
      handle: { ...HANDLE, attachmentId: HANDLE.attachmentId! },
      updatedAt: 1,
    };
    const removeAttachmentInfo = vi.fn(async () => true);
    const adapter = buildAdapter(async () => {
      throw Object.assign(new Error('tmux target disappeared during kill'), { code: 'ENOENT' });
    });
    vi.mocked(adapter.evaluateLiveness).mockResolvedValue({
      paneAlive: false,
      paneDead: true,
      observedAt: 2,
    });

    await expect(executeTerminalHostDisposition({
      happyHomeDir: '/tmp/happy',
      sessionId: attachment.sessionId,
      expectedAttachmentId: attachment.attachmentId,
      intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
      adapter,
      readAttachmentInfo: vi.fn(async () => attachment),
      removeAttachmentInfo,
    })).resolves.toEqual({ status: 'destroyed', attachmentId: attachment.attachmentId });

    expect(adapter.evaluateLiveness).toHaveBeenCalledWith(attachment.handle);
    expect(removeAttachmentInfo).toHaveBeenCalledOnce();
  });

  it('retains the retry descriptor and logs the disposal failure when host death is unproven', async () => {
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const attachment = {
      version: 2 as const,
      attachmentId: HANDLE.attachmentId!,
      sessionId: 'session-dispose-failed',
      handle: { ...HANDLE, attachmentId: HANDLE.attachmentId! },
      updatedAt: 1,
    };
    const removeAttachmentInfo = vi.fn(async () => true);
    const disposalError = Object.assign(new Error('permission denied while closing pane'), { code: 'EPERM' });
    const adapter = buildAdapter(async () => {
      throw disposalError;
    });
    vi.mocked(adapter.evaluateLiveness).mockResolvedValue({ paneAlive: true, observedAt: 2 });

    await expect(executeTerminalHostDisposition({
      happyHomeDir: '/tmp/happy',
      sessionId: attachment.sessionId,
      expectedAttachmentId: attachment.attachmentId,
      intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
      adapter,
      readAttachmentInfo: vi.fn(async () => attachment),
      removeAttachmentInfo,
    })).resolves.toEqual({ status: 'parked', reason: 'destroy_failed',
      failureCause: { phase: 'terminal_host.disposition.destroy', errorClass: 'Error', errorCode: 'EPERM', httpStatus: null } });

    expect(removeAttachmentInfo).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      '[TERMINAL HOST] Failed to destroy exact terminal host; retaining descriptor for retry',
      expect.objectContaining({
        sessionId: attachment.sessionId,
        attachmentId: attachment.attachmentId,
        hostKind: 'tmux',
        error: disposalError,
        livenessStatus: 'alive',
      }),
    );
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
      failureCause: { phase: 'terminal_host.disposition.retirement', errorClass: 'Error', errorCode: null, httpStatus: null },
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

      expect(results).toEqual([
        { status: 'destroyed', attachmentId: attachment.attachmentId },
        { status: 'destroyed', attachmentId: attachment.attachmentId },
      ]);
      expect(dispose).toHaveBeenCalledTimes(1);
      await expect(readTerminalHostAttachmentInfo({ happyHomeDir: dir.name, sessionId: 'session-1' }))
        .resolves.toBeNull();
    } finally {
      dir.removeCallback();
    }
  });

  it('joins the exact in-flight result after its descriptor has already been removed', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    let releaseRetirement!: () => void;
    const pending = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    try {
      const sessionId = 'session-retirement-pending';
      const attachment = await writeTerminalHostAttachmentInfo({ happyHomeDir: dir.name, sessionId, handle: HANDLE });
      let descriptorRemoved = false;
      const dispose = vi.fn(async () => undefined);
      const input = {
        happyHomeDir: dir.name, sessionId, expectedAttachmentId: attachment.attachmentId,
        intent: { kind: 'destroy_owned_host' as const, reason: 'explicit_user_stop' as const },
        adapter: buildAdapter(dispose),
        removeAttachmentInfo: async (target: Parameters<typeof removeTerminalHostAttachmentInfo>[0]) => {
          const removed = await removeTerminalHostAttachmentInfo(target);
          descriptorRemoved = true;
          await pending;
          return removed;
        },
      };
      const first = executeTerminalHostDisposition(input);
      await vi.waitFor(() => expect(descriptorRemoved).toBe(true));
      const joined = executeTerminalHostDisposition(input);
      releaseRetirement();
      await expect(Promise.all([first, joined])).resolves.toEqual([
        { status: 'destroyed', attachmentId: attachment.attachmentId },
        { status: 'destroyed', attachmentId: attachment.attachmentId },
      ]);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      releaseRetirement();
      dir.removeCallback();
    }
  });

  it('reclaims retained session-hook artifacts when the exact attachment is retired', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    const sessionId = 'session-hook-artifact-retirement';
    try {
      const hooks = createSessionHooksService({
        happyHomeDir: dir.name,
        hasCapability: (capability) => capability === 'sessionHooks',
      });
      const pluginDir = await hooks.createPluginDir({
        providerId: 'claude',
        lifecycle: { kind: 'session', sessionId },
        files: [{ path: '.claude-plugin/plugin.json', json: { name: 'retained-terminal-hook' } }],
      });
      await hooks.disposePluginDir(pluginDir);
      await expect(stat(pluginDir)).resolves.toBeDefined();

      const attachment = await writeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        handle: HANDLE,
      });

      await expect(executeTerminalHostDisposition({
        happyHomeDir: dir.name,
        sessionId,
        expectedAttachmentId: attachment.attachmentId,
        intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
        adapter: buildAdapter(async () => undefined),
      })).resolves.toEqual({ status: 'destroyed', attachmentId: attachment.attachmentId });

      await expect(stat(pluginDir)).rejects.toMatchObject({ code: 'ENOENT' });
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

    const input = {
      happyHomeDir: '/tmp/happy',
      sessionId: legacy.sessionId,
      expectedAttachmentInfo: legacy,
      readAttachmentInfo: vi.fn(async () => legacy),
      removeAttachmentInfo,
    };
    await expect(Promise.all([
      executeConfirmedDeadTerminalHostAttachmentRetirement(input),
      executeConfirmedDeadTerminalHostAttachmentRetirement(input),
    ])).resolves.toEqual([
      { status: 'retired', attachmentId: null },
      { status: 'retired', attachmentId: null },
    ]);
    expect(removeAttachmentInfo).toHaveBeenCalledOnce();
    expect(removeAttachmentInfo).toHaveBeenCalledWith({
      happyHomeDir: '/tmp/happy',
      sessionId: legacy.sessionId,
      expectedHandle: legacy.handle,
    });
  });
});
