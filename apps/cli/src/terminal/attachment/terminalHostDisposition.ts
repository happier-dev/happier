import type { TerminalHostAdapter, TerminalHostHandle } from '@happier-dev/agents';
import type { AgentTerminalHostDisposeIntent } from '@happier-dev/plugin-sdk/agents/runtime';
import { projectActionFailureCauseV1, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { probeTerminalHostForRecovery } from '@/integrations/terminal/host/recoveryLiveness';
import { disposeSessionHookArtifactsForSession } from '@/plugins/runtime/hooks/session/service';
import { logger } from '@/ui/logger';
import { retireTerminalClientProcess } from '@/terminal/host/terminalClientCustody';

import {
  readTerminalHostAttachmentState,
  removeTerminalHostAttachmentInfo,
  type ExactTerminalHostAttachmentInfo,
  type TerminalAttachmentId,
  type TerminalHostAttachmentInfo,
  type TerminalHostAttachmentReadState,
} from './terminalAttachmentInfo';

export type TerminalHostDispositionIntent =
  | Readonly<{
      kind: 'preserve_host';
      reason: 'planned_runner_refresh' | 'wrapper_exit' | 'controller_failure' | 'auth_switch_handoff';
      runtimePhase: 'transfer_pending' | 'blocked';
    }>
  | Readonly<{ kind: 'destroy_owned_host'; reason: 'explicit_user_stop' | 'session_closed' | 'unrecoverable_control_recovery' }>
  | Readonly<{ kind: 'retire_confirmed_dead_attachment'; reason: 'positive_dead_recovery' }>
  | Readonly<{ kind: 'release_borrowed_host'; reason: 'provider_exit' | 'explicit_user_stop' | 'wrapper_exit' }>;

export type TerminalHostDispositionResult = Readonly<{ failureCause?: ActionFailureCauseV1 }> & (
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
      reason: 'legacy_attachment' | 'attachment_mismatch' | 'missing_topology_proof' | 'disposition_in_progress' | 'destroy_failed' | 'retirement_failed' | 'descriptor_retirement_failed';
    }>);

const activeDispositionClaims = new Map<string, Promise<TerminalHostDispositionResult>>();

async function joinTerminalHostDisposition(
  claimKey: string,
  dispose: () => Promise<TerminalHostDispositionResult>,
): Promise<TerminalHostDispositionResult> {
  const active = activeDispositionClaims.get(claimKey);
  if (active) return await active;
  // Publish the joinable operation before any disposal or retirement callback runs.
  const pending = Promise.resolve().then(dispose);
  activeDispositionClaims.set(claimKey, pending);
  try {
    return await pending;
  } finally {
    activeDispositionClaims.delete(claimKey);
  }
}

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
  /** Exact evidence captured before a positively proven runner exit. */
  expectedAttachmentInfo?: ExactTerminalHostAttachmentInfo;
  intent: TerminalHostDispositionIntent;
  adapter?: TerminalHostAdapter;
  readAttachmentInfo?: (input: Readonly<{ happyHomeDir: string; sessionId: string }>) => Promise<TerminalHostAttachmentInfo | null>;
  readAttachmentState?: (input: Readonly<{ happyHomeDir: string; sessionId: string }>) => Promise<TerminalHostAttachmentReadState>;
  removeAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    expectedAttachmentId: TerminalAttachmentId | string;
  }>) => Promise<boolean>;
  beforeDescriptorRetirement?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: ExactTerminalHostAttachmentInfo;
  }>) => Promise<void>;
}>): Promise<TerminalHostDispositionResult> {
  const claimKey = `${input.happyHomeDir}\u0000${input.sessionId}\u0000${input.expectedAttachmentId}`;
  if (input.intent.kind !== 'preserve_host') {
    const active = activeDispositionClaims.get(claimKey);
    if (active) return await active;
  }
  const readCurrent = async (): Promise<TerminalHostAttachmentInfo | null> => {
    const target = { happyHomeDir: input.happyHomeDir, sessionId: input.sessionId };
    if (input.readAttachmentState || !input.readAttachmentInfo) {
      const state = await (input.readAttachmentState ?? readTerminalHostAttachmentState)(target);
      if (state.status === 'unreadable') throw new Error('terminal_attachment_unreadable');
      return state.status === 'present' ? state.info : null;
    }
    return await input.readAttachmentInfo(target);
  };
  const removeAttachment = input.removeAttachmentInfo ?? removeTerminalHostAttachmentInfo;
  const expected = input.expectedAttachmentInfo;
  const captured = expected
    && expected.sessionId === input.sessionId
    && expected.attachmentId === input.expectedAttachmentId
    && expected.handle.attachmentId === expected.attachmentId
    && ((expected.version === 2 && input.intent.kind === 'destroy_owned_host')
      || (expected.version === 3 && input.intent.kind === 'release_borrowed_host'))
    ? expected
    : null;
  let attachmentInfo: TerminalHostAttachmentInfo | null;
  try {
    attachmentInfo = await readCurrent() ?? captured;
  } catch (error) {
    logger.infoFile('[TERMINAL HOST] Disposition could not read exact attachment evidence', {
      sessionId: input.sessionId,
      attachmentId: input.expectedAttachmentId,
    });
    return { status: 'parked', reason: 'missing_topology_proof',
      failureCause: projectActionFailureCauseV1(error, 'terminal_host.disposition.read') };
  }
  if (!attachmentInfo || attachmentInfo.version === 1) {
    return { status: 'parked', reason: 'legacy_attachment' };
  }
  if (attachmentInfo.attachmentId !== input.expectedAttachmentId) {
    return { status: 'parked', reason: 'attachment_mismatch' };
  }
  if (input.intent.kind === 'preserve_host') {
    return { status: 'preserved', attachmentId: attachmentInfo.attachmentId };
  }

  return await joinTerminalHostDisposition(claimKey, async () => {
    let current: TerminalHostAttachmentInfo | null;
    try {
      current = await readCurrent() ?? captured;
    } catch (error) {
      logger.infoFile('[TERMINAL HOST] Disposition could not verify exact attachment evidence', {
        sessionId: input.sessionId,
        attachmentId: input.expectedAttachmentId,
      });
      return { status: 'parked', reason: 'missing_topology_proof',
        failureCause: projectActionFailureCauseV1(error, 'terminal_host.disposition.verify') };
    }
    if (!current || current.version === 1 || current.attachmentId !== attachmentInfo.attachmentId) {
      return { status: 'parked', reason: 'attachment_mismatch' };
    }
    if (input.intent.kind === 'retire_confirmed_dead_attachment' || input.intent.kind === 'release_borrowed_host') {
      if (input.intent.kind === 'release_borrowed_host' && current.version !== 3) {
        return { status: 'parked', reason: 'attachment_mismatch' };
      }
      try {
        if (current.version === 3 && current.nativeClientProcess) {
          await retireTerminalClientProcess(current.nativeClientProcess);
        }
        await input.beforeDescriptorRetirement?.({
          happyHomeDir: input.happyHomeDir,
          sessionId: input.sessionId,
          attachmentInfo: current,
        });
      } catch (error) {
        return { status: 'parked', reason: 'retirement_failed',
          failureCause: projectActionFailureCauseV1(error, 'terminal_host.disposition.retirement') };
      }
      let removed: boolean;
      try {
        removed = await removeAttachment({
          happyHomeDir: input.happyHomeDir,
          sessionId: input.sessionId,
          expectedAttachmentId: current.attachmentId,
        });
      } catch (error) {
        logger.infoFile('[TERMINAL HOST] Failed to retire exact terminal attachment descriptor; retaining evidence for retry', {
          sessionId: input.sessionId,
          attachmentId: current.attachmentId,
        });
        return { status: 'parked', reason: 'descriptor_retirement_failed',
          failureCause: projectActionFailureCauseV1(error, 'terminal_host.disposition.descriptor_retirement') };
      }
      if (!removed) {
        let alreadyAbsent = false;
        try {
          alreadyAbsent = captured !== null && await readCurrent() === null;
        } catch (error) {
          logger.infoFile('[TERMINAL HOST] Disposition could not verify borrowed attachment retirement', {
            sessionId: input.sessionId,
            attachmentId: input.expectedAttachmentId,
          });
          return { status: 'parked', reason: 'missing_topology_proof',
            failureCause: projectActionFailureCauseV1(error, 'terminal_host.disposition.verify_retirement') };
        }
        if (!alreadyAbsent) return { status: 'parked', reason: 'attachment_mismatch' };
      }
      await disposeRetiredTerminalSessionHookArtifacts({
        happyHomeDir: input.happyHomeDir,
        sessionId: input.sessionId,
        attachmentId: current.attachmentId,
      });
      return { status: 'retired', attachmentId: current.attachmentId };
    }

    if (current.version !== 2) {
      return { status: 'parked', reason: 'attachment_mismatch' };
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
    } catch (error) {
      const liveness = await probeTerminalHostForRecovery({
        adapter: input.adapter,
        handle,
      });
      if (liveness.status !== 'dead') {
        logger.warn('[TERMINAL HOST] Failed to destroy exact terminal host; retaining descriptor for retry', {
          sessionId: input.sessionId,
          attachmentId: current.attachmentId,
          hostKind: handle.kind,
          error,
          livenessStatus: liveness.status,
          liveness: liveness.liveness,
        });
        return { status: 'parked', reason: 'destroy_failed',
          failureCause: projectActionFailureCauseV1(error, 'terminal_host.disposition.destroy') };
      }
    }
    try {
      await input.beforeDescriptorRetirement?.({
        happyHomeDir: input.happyHomeDir,
        sessionId: input.sessionId,
        attachmentInfo: current,
      });
    } catch (error) {
      return {
        status: 'destroyed',
        attachmentId: current.attachmentId,
        descriptorRetained: true,
        retirementFailed: true,
        failureCause: projectActionFailureCauseV1(error, 'terminal_host.disposition.retirement'),
      };
    }
    let descriptorRetirementFailureCause: ActionFailureCauseV1 | undefined;
    const removed = await removeAttachment({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
      expectedAttachmentId: current.attachmentId,
    }).catch((error: unknown) => {
      descriptorRetirementFailureCause = projectActionFailureCauseV1(error, 'terminal_host.disposition.descriptor_retirement');
      logger.infoFile('[TERMINAL HOST] Failed to retire descriptor after exact host destruction; retaining evidence for retry', {
        sessionId: input.sessionId,
        attachmentId: current.attachmentId,
      });
      return false;
    });
    // Absence is completion evidence only after the exact disposal/retirement
    // pipeline above; it never substitutes for physical disposal.
    const alreadyAbsent = !removed && captured !== null
      && await readCurrent().then((info) => info === null, (error: unknown) => {
        descriptorRetirementFailureCause ??= projectActionFailureCauseV1(error, 'terminal_host.disposition.verify_retirement');
        logger.infoFile('[TERMINAL HOST] Could not verify descriptor retirement after exact host destruction; retaining evidence for retry', {
          sessionId: input.sessionId,
          attachmentId: current.attachmentId,
        });
        return false;
      });
    if (!removed && !alreadyAbsent) {
      return { status: 'destroyed', attachmentId: current.attachmentId, descriptorRetained: true,
        ...(descriptorRetirementFailureCause ? { failureCause: descriptorRetirementFailureCause } : {}) };
    }
    await disposeRetiredTerminalSessionHookArtifacts({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
      attachmentId: current.attachmentId,
    });
    return { status: 'destroyed', attachmentId: current.attachmentId };
  });
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
    attachmentInfo: ExactTerminalHostAttachmentInfo;
  }>) => Promise<void>;
}>): Promise<TerminalHostDispositionResult> {
  if (input.expectedAttachmentInfo.version === 2 || input.expectedAttachmentInfo.version === 3) {
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
  return await joinTerminalHostDisposition(claimKey, async () => {
    const removeAttachment = input.removeAttachmentInfo ?? removeTerminalHostAttachmentInfo;
    let failureCause: ActionFailureCauseV1 | undefined;
    const removed = await removeAttachment({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
      expectedHandle: expected.handle,
    }).catch((error: unknown) => {
      failureCause = projectActionFailureCauseV1(error, 'terminal_host.disposition.descriptor_retirement');
      return false;
    });
    if (!removed) return { status: 'parked', reason: 'attachment_mismatch', ...(failureCause ? { failureCause } : {}) };
    await disposeRetiredTerminalSessionHookArtifacts({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
      attachmentId: null,
    });
    return { status: 'retired', attachmentId: null };
  });
}
