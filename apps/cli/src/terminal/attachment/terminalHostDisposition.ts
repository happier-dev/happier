import type { TerminalHostAdapter } from '@happier-dev/agents';
import type { AgentSessionHostServices } from '@happier-dev/plugin-sdk/agent-runtime';

import {
  readTerminalHostAttachmentInfo,
  removeTerminalHostAttachmentInfo,
  type TerminalAttachmentId,
  type TerminalHostAttachmentInfo,
} from './terminalAttachmentInfo';

type AgentTerminalHostDisposeIntent =
  Parameters<NonNullable<AgentSessionHostServices['terminalHost']>['dispose']>[1];

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
  | Readonly<{ status: 'retired'; attachmentId: TerminalAttachmentId }>
  | Readonly<{ status: 'destroyed'; attachmentId: TerminalAttachmentId; descriptorRetained?: true }>
  | Readonly<{
      status: 'parked';
      reason: 'legacy_attachment' | 'attachment_mismatch' | 'missing_topology_proof' | 'disposition_in_progress' | 'destroy_failed';
    }>;

const activeDispositionClaims = new Set<string>();

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
      const removed = await removeAttachment({
        happyHomeDir: input.happyHomeDir,
        sessionId: input.sessionId,
        expectedAttachmentId: current.attachmentId,
      });
      return removed
        ? { status: 'retired', attachmentId: current.attachmentId }
        : { status: 'parked', reason: 'attachment_mismatch' };
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
    const removed = await removeAttachment({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
      expectedAttachmentId: current.attachmentId,
    }).catch(() => false);
    return removed
      ? { status: 'destroyed', attachmentId: current.attachmentId }
      : { status: 'destroyed', attachmentId: current.attachmentId, descriptorRetained: true };
  } finally {
    activeDispositionClaims.delete(claimKey);
  }
}
