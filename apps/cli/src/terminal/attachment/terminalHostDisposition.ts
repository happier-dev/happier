import type { TerminalAttachmentId, TerminalHostAdapter } from '@/integrations/terminalHost/_types';
import {
  readTerminalAttachmentInfo,
  removeTerminalAttachmentInfo,
  type BoundTerminalAttachmentInfo,
  type TerminalAttachmentInfo,
} from './terminalAttachmentInfo';

export type TerminalHostDispositionIntent =
  | Readonly<{
      kind: 'preserve_host';
      reason: 'planned_runner_refresh' | 'wrapper_exit' | 'controller_failure' | 'auth_switch_handoff';
      runtimePhase: 'transfer_pending' | 'blocked';
    }>
  | Readonly<{
      kind: 'destroy_owned_host';
      reason: 'explicit_user_stop' | 'unrecoverable_control_recovery';
    }>
  | Readonly<{
      kind: 'retire_confirmed_dead_attachment';
      reason: 'positive_dead_recovery';
    }>;

export type TerminalHostDispositionResult =
  | Readonly<{ status: 'preserved'; attachmentId: TerminalAttachmentId }>
  | Readonly<{ status: 'retired'; attachmentId: TerminalAttachmentId }>
  | Readonly<{ status: 'retired_legacy' }>
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

export async function executeTerminalHostDisposition(input: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  expectedAttachmentId: TerminalAttachmentId | string;
  intent: TerminalHostDispositionIntent;
  adapter?: TerminalHostAdapter;
  /**
   * For legacy v1 retirement: the exact terminal metadata the caller probed and confirmed dead.
   * The on-disk record is only removed when it deep-equals this value, preventing removal of
   * a concurrently rewritten record whose liveness was never verified.
   */
  provenDeadLegacyTerminal?: TerminalAttachmentInfo['terminal'];
  readAttachmentInfo?: (input: Readonly<{ happyHomeDir: string; sessionId: string }>) => Promise<TerminalAttachmentInfo | null>;
  removeAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    expectedAttachmentId: TerminalAttachmentId | string;
    expectedTerminal: TerminalAttachmentInfo['terminal'];
    legacyTerminalMetadataRemoval?: boolean;
  }>) => Promise<boolean>;
  /** Runs after physical retirement is proven and before the local retry identity is removed. */
  beforeDescriptorRetirement?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalAttachmentInfo;
  }>) => Promise<void>;
}>): Promise<TerminalHostDispositionResult> {
  const readAttachment = input.readAttachmentInfo ?? readTerminalAttachmentInfo;
  const removeAttachment = input.removeAttachmentInfo ?? removeTerminalAttachmentInfo;
  const attachmentInfo = await readAttachment({
    happyHomeDir: input.happyHomeDir,
    sessionId: input.sessionId,
  });
  if (!attachmentInfo) {
    return { status: 'parked', reason: 'legacy_attachment' };
  }
  if (attachmentInfo.version === 1) {
    // Legacy v1 records can only be retired when the host is confirmed dead.
    // For destroy or preserve intents, we cannot safely proceed without an immutable identity.
    if (input.intent.kind !== 'retire_confirmed_dead_attachment') {
      return { status: 'parked', reason: 'legacy_attachment' };
    }
    // Remove the v1 descriptor by terminal metadata match (no attachmentId CAS).
    // Compare against the caller's proven-dead terminal, not the fresh read's own terminal,
    // so a concurrent rewrite with different metadata is not silently removed.
    const legacyExpectedTerminal = input.provenDeadLegacyTerminal ?? attachmentInfo.terminal;
    const removed = await removeAttachment({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
      expectedAttachmentId: input.expectedAttachmentId,
      expectedTerminal: legacyExpectedTerminal,
      legacyTerminalMetadataRemoval: true,
    });
    return removed
      ? { status: 'retired_legacy' }
      : { status: 'parked', reason: 'legacy_attachment' };
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
    const current = await readAttachment({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
    });
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
        expectedTerminal: current.terminal,
      });
      return removed
        ? { status: 'retired', attachmentId: current.attachmentId }
        : { status: 'parked', reason: 'attachment_mismatch' };
    }

    const handle = current.handle;
    if (
      !input.adapter
      || input.adapter.kind !== handle.kind
      || handle.attachmentId !== current.attachmentId
      || (handle.attachMetadata.topology === 'shared' && !handle.paneId?.trim())
    ) {
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
      expectedTerminal: current.terminal,
    });
    return removed
      ? { status: 'destroyed', attachmentId: current.attachmentId }
      : { status: 'destroyed', attachmentId: current.attachmentId, descriptorRetained: true };
  } finally {
    activeDispositionClaims.delete(claimKey);
  }
}
