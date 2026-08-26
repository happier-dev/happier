import type { TerminalHostAdapter, TerminalHostHandle } from '@happier-dev/agents';
import type { AgentTerminalHostDisposeIntent } from '@happier-dev/plugin-sdk/agents/runtime';
import { disposeSessionHookArtifactsForSession } from '@/plugins/runtime/hooks/session/service';
import { logger } from '@/ui/logger';

import {
  readTerminalHostAttachmentInfo,
  removeTerminalHostAttachmentInfo,
  type BoundTerminalHostAttachmentInfo,
  type TerminalAttachmentId,
  type TerminalHostAttachmentInfo,
} from './terminalAttachmentInfo';

export type TerminalHostDispositionIntent =
  | Readonly<{
      kind: 'preserve_host';
      reason: 'planned_runner_refresh' | 'wrapper_exit' | 'controller_failure' | 'auth_switch_handoff';
      runtimePhase: 'transfer_pending' | 'blocked';
    }>
  | Readonly<{ kind: 'destroy_owned_host'; reason: 'explicit_user_stop' | 'session_closed' }>
  | Readonly<{ kind: 'retire_confirmed_dead_attachment'; reason: 'positive_dead_recovery' }>;

export type TerminalHostDispositionResult =
  | Readonly<{ status: 'preserved'; attachmentId: TerminalAttachmentId }>
  | Readonly<{ status: 'retired'; attachmentId: TerminalAttachmentId | null }>
  | Readonly<{
      status: 'destroyed';
      attachmentId: TerminalAttachmentId;
      descriptorRetained?: true;
      retirementFailed?: true;
    }>
  | Readonly<{
      status: 'parked';
      reason: 'legacy_attachment' | 'attachment_mismatch' | 'missing_topology_proof' | 'disposition_in_progress' | 'destroy_failed' | 'retirement_failed';
    }>;

const activeDispositionClaims = new Set<string>();

async function disposeRetiredTerminalSessionHookArtifacts(input: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  attachmentId: TerminalAttachmentId | null;
}>): Promise<void> {
  try {
    await disposeSessionHookArtifactsForSession({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
    });
  } catch (error) {
    // Attachment retirement is already durable; hook artifacts are best-effort cleanup.
    logger.warn('[TERMINAL HOST] Failed to clean session-hook artifacts after terminal attachment retirement', {
      sessionId: input.sessionId,
      attachmentId: input.attachmentId,
      error,
    });
  }
}

export function resolveRuntimeTerminalHostDispositionIntent(
  intent: AgentTerminalHostDisposeIntent,
): TerminalHostDispositionIntent {
  if (intent.kind === 'destroy_owned_host') {
    return { kind: 'destroy_owned_host', reason: 'session_closed' };
  }
  return {
    kind: 'preserve_host',
    reason: intent.reason === 'plugin_deactivated'
      ? 'planned_runner_refresh'
      : intent.reason === 'runtime_recovery'
        ? 'controller_failure'
        : 'wrapper_exit',
    runtimePhase: 'transfer_pending',
  };
}

export async function executeTerminalHostDisposition(input: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  expectedAttachmentId: TerminalAttachmentId | string;
  intent: TerminalHostDispositionIntent;
  adapter?: TerminalHostAdapter;
  readAttachmentInfo?: (input: Readonly<{ happyHomeDir: string; sessionId: string }>) => Promise<TerminalHostAttachmentInfo | null>;
  removeAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    expectedAttachmentId: TerminalAttachmentId | string;
  }>) => Promise<boolean>;
  beforeDescriptorRetirement?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalHostAttachmentInfo;
  }>) => Promise<void>;
}>): Promise<TerminalHostDispositionResult> {
  const readAttachment = input.readAttachmentInfo ?? readTerminalHostAttachmentInfo;
  const removeAttachment = input.removeAttachmentInfo ?? removeTerminalHostAttachmentInfo;
  const attachmentInfo = await readAttachment({ happyHomeDir: input.happyHomeDir, sessionId: input.sessionId });
  if (!attachmentInfo || attachmentInfo.version === 1) {
    return { status: 'parked', reason: 'legacy_attachment' };
  }
  if (attachmentInfo.attachmentId !== input.expectedAttachmentId) {
    return { status: 'parked', reason: 'attachment_mismatch' };
  }
  if (input.intent.kind === 'preserve_host') {
    return { status: 'preserved', attachmentId: attachmentInfo.attachmentId };
  }

  const claimKey = `${input.happyHomeDir}\u0000${input.sessionId}\u0000${attachmentInfo.attachmentId}`;
  if (activeDispositionClaims.has(claimKey)) {
    return { status: 'parked', reason: 'disposition_in_progress' };
  }
  activeDispositionClaims.add(claimKey);
  try {
    const current = await readAttachment({ happyHomeDir: input.happyHomeDir, sessionId: input.sessionId });
    if (current?.version !== 2 || current.attachmentId !== attachmentInfo.attachmentId) {
      return { status: 'parked', reason: 'attachment_mismatch' };
    }
    if (input.intent.kind === 'retire_confirmed_dead_attachment') {
      try {
        await input.beforeDescriptorRetirement?.({
          happyHomeDir: input.happyHomeDir,
          sessionId: input.sessionId,
          attachmentInfo: current,
        });
      } catch {
        return { status: 'parked', reason: 'retirement_failed' };
      }
      const removed = await removeAttachment({
        happyHomeDir: input.happyHomeDir,
        sessionId: input.sessionId,
        expectedAttachmentId: current.attachmentId,
      });
      if (!removed) return { status: 'parked', reason: 'attachment_mismatch' };
      await disposeRetiredTerminalSessionHookArtifacts({
        happyHomeDir: input.happyHomeDir,
        sessionId: input.sessionId,
        attachmentId: current.attachmentId,
      });
      return { status: 'retired', attachmentId: current.attachmentId };
    }

    const handle = current.handle;
    if (!input.adapter
      || input.adapter.kind !== handle.kind
      || handle.attachmentId !== current.attachmentId
      || (handle.attachMetadata.topology === 'shared' && !handle.paneId?.trim())) {
      return { status: 'parked', reason: 'missing_topology_proof' };
    }
    try {
      await input.adapter.dispose(handle);
    } catch {
      return { status: 'parked', reason: 'destroy_failed' };
    }
    try {
      await input.beforeDescriptorRetirement?.({
        happyHomeDir: input.happyHomeDir,
        sessionId: input.sessionId,
        attachmentInfo: current,
      });
    } catch {
      return {
        status: 'destroyed',
        attachmentId: current.attachmentId,
        descriptorRetained: true,
        retirementFailed: true,
      };
    }
    const removed = await removeAttachment({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
      expectedAttachmentId: current.attachmentId,
    }).catch(() => false);
    if (!removed) {
      return { status: 'destroyed', attachmentId: current.attachmentId, descriptorRetained: true };
    }
    await disposeRetiredTerminalSessionHookArtifacts({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
      attachmentId: current.attachmentId,
    });
    return { status: 'destroyed', attachmentId: current.attachmentId };
  } finally {
    activeDispositionClaims.delete(claimKey);
  }
}

export async function executeConfirmedDeadTerminalHostAttachmentRetirement(input: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  expectedAttachmentInfo: TerminalHostAttachmentInfo;
  readAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
  }>) => Promise<TerminalHostAttachmentInfo | null>;
  removeAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    expectedAttachmentId?: TerminalAttachmentId | string;
    expectedHandle?: TerminalHostHandle;
  }>) => Promise<boolean>;
  beforeDescriptorRetirement?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalHostAttachmentInfo;
  }>) => Promise<void>;
}>): Promise<TerminalHostDispositionResult> {
  if (input.expectedAttachmentInfo.version === 2) {
    return await executeTerminalHostDisposition({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
      expectedAttachmentId: input.expectedAttachmentInfo.attachmentId,
      intent: { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
      readAttachmentInfo: input.readAttachmentInfo,
      removeAttachmentInfo: input.removeAttachmentInfo,
      beforeDescriptorRetirement: input.beforeDescriptorRetirement,
    });
  }

  const expected = input.expectedAttachmentInfo;
  const claimKey = `${input.happyHomeDir}\u0000${input.sessionId}\u0000legacy:${expected.updatedAt}`;
  if (activeDispositionClaims.has(claimKey)) {
    return { status: 'parked', reason: 'disposition_in_progress' };
  }
  activeDispositionClaims.add(claimKey);
  try {
    const removeAttachment = input.removeAttachmentInfo ?? removeTerminalHostAttachmentInfo;
    const removed = await removeAttachment({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
      expectedHandle: expected.handle,
    }).catch(() => false);
    if (!removed) return { status: 'parked', reason: 'attachment_mismatch' };
    await disposeRetiredTerminalSessionHookArtifacts({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
      attachmentId: null,
    });
    return { status: 'retired', attachmentId: null };
  } finally {
    activeDispositionClaims.delete(claimKey);
  }
}
