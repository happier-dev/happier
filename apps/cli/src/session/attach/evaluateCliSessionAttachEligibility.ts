import {
  getAgentLocalControlCapability,
  inferAgentIdFromSessionMetadata,
  type AgentId,
} from '@happier-dev/agents';

import { getProviderAttachOps } from '@/backends/catalog';
import type { Credentials } from '@/persistence';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { createTerminalAttachPlan, type TerminalAttachPlan } from '@/terminal/attachment/terminalAttachPlan';
import type { Metadata } from '@/api/types';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionListRow, RawSessionRecord } from '@/session/transport/http/sessionsHttp';

export type CliSessionAttachEligibilityReasonCode =
  | 'archived'
  | 'inactive'
  | 'metadata_unavailable'
  | 'current_machine_unknown'
  | 'session_machine_unknown'
  | 'not_current_machine'
  | 'local_control_unsupported'
  | 'provider_attach_unavailable'
  | 'missing_local_attach_state'
  | 'terminal_not_attachable';

export type CliSessionAttachEligibility =
  | Readonly<{
      eligible: true;
      agentId: AgentId;
      attachStrategy: 'provider_attach';
      attachScope: 'local' | 'remote';
      metadata: Record<string, unknown>;
    }>
  | Readonly<{
      eligible: true;
      agentId: AgentId;
      attachStrategy: 'terminal_host';
      attachScope: 'local';
      terminal: NonNullable<Metadata['terminal']>;
      plan: Exclude<TerminalAttachPlan, { type: 'not-attachable' }>;
      metadata: Record<string, unknown> | null;
    }>
  | Readonly<{
      eligible: false;
      agentId: AgentId | null;
      reasonCode: CliSessionAttachEligibilityReasonCode;
      reason: string;
      metadata: Record<string, unknown> | null;
    }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveArchivedAt(rawSession: RawSessionListRow | RawSessionRecord): number | null {
  const archivedAt = (rawSession as { archivedAt?: unknown }).archivedAt;
  return typeof archivedAt === 'number' && Number.isFinite(archivedAt) ? archivedAt : null;
}

function readMachineId(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const value = metadata.machineId;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveAgentId(metadata: Record<string, unknown> | null): AgentId | null {
  return metadata ? inferAgentIdFromSessionMetadata(metadata) : null;
}

function buildTerminalAttachEligibility(params: Readonly<{
  metadata: Record<string, unknown> | null;
  localAttachmentInfo: TerminalAttachmentInfo | null;
  insideTmux: boolean;
  currentTmuxSocketPath?: string | null;
}>): CliSessionAttachEligibility {
  const localTerminal = params.localAttachmentInfo?.terminal ?? null;

  if (localTerminal) {
    const plan = createTerminalAttachPlan({
      terminal: localTerminal,
      insideTmux: params.insideTmux,
      currentTmuxSocketPath: params.currentTmuxSocketPath ?? null,
    });
    if (plan.type === 'not-attachable') {
      return {
        eligible: false,
        agentId: resolveAgentId(params.metadata),
        reasonCode: 'terminal_not_attachable',
        reason: plan.reason,
        metadata: params.metadata,
      };
    }
    return {
      eligible: true,
      agentId: resolveAgentId(params.metadata) ?? 'claude',
      attachStrategy: 'terminal_host',
      attachScope: 'local',
      terminal: localTerminal,
      plan,
      metadata: params.metadata,
    };
  }

  return {
    eligible: false,
    agentId: resolveAgentId(params.metadata),
    reasonCode: 'missing_local_attach_state',
    reason: 'No local attachment info found for this session on this computer.',
    metadata: params.metadata,
  };
}

export async function evaluateCliSessionAttachEligibility(params: Readonly<{
  credentials: Credentials;
  rawSession: RawSessionListRow | RawSessionRecord;
  currentMachineId: string | null;
  currentMachineHost?: string | null;
  localAttachmentInfo: TerminalAttachmentInfo | null;
  insideTmux: boolean;
  currentTmuxSocketPath?: string | null;
}>): Promise<CliSessionAttachEligibility> {
  if (resolveArchivedAt(params.rawSession) !== null) {
    return {
      eligible: false,
      agentId: null,
      reasonCode: 'archived',
      reason: 'Session is archived and cannot be attached.',
      metadata: null,
    };
  }
  if (params.rawSession.active !== true) {
    return {
      eligible: false,
      agentId: null,
      reasonCode: 'inactive',
      reason: 'Session is not active and cannot be attached.',
      metadata: null,
    };
  }

  const metadata = asRecord(tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession: params.rawSession,
  }));
  const agentId = resolveAgentId(metadata);

  if (!metadata) {
    return {
      eligible: false,
      agentId,
      reasonCode: 'metadata_unavailable',
      reason: 'Failed to decrypt session metadata.',
      metadata: null,
    };
  }

  const localControl = agentId ? getAgentLocalControlCapability(agentId) : null;
  const sessionMachineId = readMachineId(metadata);
  const hasLocalTerminalEvidence = params.localAttachmentInfo !== null;
  if (!localControl) {
    return {
      eligible: false,
      agentId,
      reasonCode: 'local_control_unsupported',
      reason: 'This session does not support terminal attach.',
      metadata,
    };
  }

  if (localControl.attachStrategy === 'provider_attach') {
    if (!agentId) {
      return {
        eligible: false,
        agentId,
        reasonCode: 'provider_attach_unavailable',
        reason: 'Provider attach is not available for this session.',
        metadata,
      };
    }
    const providerAttachOps = await getProviderAttachOps(agentId);
    if (!providerAttachOps) {
      return {
        eligible: false,
        agentId,
        reasonCode: 'provider_attach_unavailable',
        reason: 'Provider attach is not available for this session.',
        metadata,
      };
    }

    const evaluation = await providerAttachOps.evaluateEligibility({
      metadata,
      currentMachineId: params.currentMachineId,
      sessionMachineId,
      hasLocalAttachmentInfo: params.localAttachmentInfo !== null,
    });
    if (!evaluation.eligible) {
      return {
        eligible: false,
        agentId,
        reasonCode: 'provider_attach_unavailable',
        reason: evaluation.reason,
        metadata,
      };
    }

    return {
      eligible: true,
      agentId,
      attachStrategy: 'provider_attach',
      attachScope: evaluation.scope,
      metadata: evaluation.metadata,
    };
  }

  if (!params.currentMachineId && !hasLocalTerminalEvidence) {
    return {
      eligible: false,
      agentId,
      reasonCode: 'current_machine_unknown',
      reason: 'Current machine id is unavailable; cannot determine whether this session belongs to this computer.',
      metadata,
    };
  }
  if (!sessionMachineId && !hasLocalTerminalEvidence) {
    return {
      eligible: false,
      agentId,
      reasonCode: 'session_machine_unknown',
      reason: 'Session does not record which machine is hosting it and cannot be safely attached.',
      metadata,
    };
  }
  if (sessionMachineId && params.currentMachineId && sessionMachineId !== params.currentMachineId && !hasLocalTerminalEvidence) {
    return {
      eligible: false,
      agentId,
      reasonCode: 'not_current_machine',
      reason: 'Session belongs to another machine and cannot be attached from this computer.',
      metadata,
    };
  }

  if (localControl.attachStrategy !== 'tmux') {
    return {
      eligible: false,
      agentId,
      reasonCode: 'local_control_unsupported',
      reason: 'This session does not support terminal attach.',
      metadata,
    };
  }

  return buildTerminalAttachEligibility({
    metadata,
    localAttachmentInfo: params.localAttachmentInfo,
    insideTmux: params.insideTmux,
    currentTmuxSocketPath: params.currentTmuxSocketPath ?? null,
  });
}
