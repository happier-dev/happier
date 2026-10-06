import {
  readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata,
  resolveAgentIdFromSessionMetadata,
  type AttachSessionMetadataV1,
} from '@happier-dev/agents';
import { compareMachineHosts } from '@happier-dev/protocol/machines/host/normalizeMachineHost';
import { createSessionOwnerMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import type { StoredCredentials } from '@/persistence';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { createTerminalAttachPlan, type TerminalAttachPlan } from '@/terminal/attachment/terminalAttachPlan';
import type { Metadata } from '@/api/types';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionListRow, RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type { BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistryTypes';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { resolveCliSessionAttachBackendId } from './resolveCliSessionAttachBackendId';

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function buildAttachSessionMetadata(metadata: Readonly<Record<string, unknown>>): AttachSessionMetadataV1 {
  const runtimeDescriptorV1 = readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata(metadata);
  return Object.freeze({
    ...(readString(metadata.path) !== undefined ? { path: readString(metadata.path) } : {}),
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
  });
}

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
      agentId: CatalogAgentId;
      attachStrategy: 'managed_provider_attach';
      attachScope: 'local';
      terminal: NonNullable<Metadata['terminal']>;
      metadata: Record<string, unknown>;
    }>
  | Readonly<{
      eligible: true;
      agentId: CatalogAgentId;
      backendId: string;
      attachStrategy: 'provider_attach';
      attachScope: 'local' | 'remote';
      metadata: AttachSessionMetadataV1;
    }>
  | Readonly<{
      eligible: true;
      agentId: CatalogAgentId | null;
      attachStrategy: 'terminal_host';
      attachScope: 'local';
      terminal: NonNullable<Metadata['terminal']>;
      plan: Exclude<TerminalAttachPlan, { type: 'not-attachable' }>;
      metadata: Record<string, unknown> | null;
    }>
  | Readonly<{
      eligible: false;
      agentId: CatalogAgentId | null;
      reasonCode: CliSessionAttachEligibilityReasonCode;
      reason: string;
      metadata: Record<string, unknown> | null;
    }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveProviderAttachScope(params: Readonly<{
  currentMachineId: string | null;
  sessionMachineId: string | null;
  hasLocalAttachmentInfo: boolean;
}>): 'local' | 'remote' {
  if (params.hasLocalAttachmentInfo) return 'local';
  return params.currentMachineId
    && params.sessionMachineId
    && params.currentMachineId === params.sessionMachineId
    ? 'local'
    : 'remote';
}

function resolveArchivedAt(rawSession: RawSessionListRow | RawSessionRecord): number | null {
  const archivedAt = (rawSession as { archivedAt?: unknown }).archivedAt;
  return typeof archivedAt === 'number' && Number.isFinite(archivedAt) ? archivedAt : null;
}

function resolveSessionId(rawSession: RawSessionListRow | RawSessionRecord): string | null {
  const id = (rawSession as { id?: unknown }).id;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
}

function readMachineId(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const value = metadata.machineId;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readHost(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const value = metadata.host;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveAgentId(metadata: Record<string, unknown> | null): CatalogAgentId | null {
  return metadata ? resolveAgentIdFromSessionMetadata(metadata) : null;
}

function buildTerminalAttachEligibility(params: Readonly<{
  metadata: Record<string, unknown> | null;
  localAttachmentInfo: TerminalAttachmentInfo | null;
  insideTmux: boolean;
  currentTmuxSocketPath?: string | null;
}>): CliSessionAttachEligibility {
  const localTerminal = params.localAttachmentInfo?.terminal ?? null;
  const metadataTerminal = asRecord(params.metadata?.terminal) as NonNullable<Metadata['terminal']> | null;

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
      agentId: resolveAgentId(params.metadata),
      attachStrategy: 'terminal_host',
      attachScope: 'local',
      terminal: localTerminal,
      plan,
      metadata: params.metadata,
    };
  }

  if (metadataTerminal) {
    const plan = createTerminalAttachPlan({
      terminal: metadataTerminal,
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
      agentId: resolveAgentId(params.metadata),
      attachStrategy: 'terminal_host',
      attachScope: 'local',
      terminal: metadataTerminal,
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
  credentials: StoredCredentials;
  rawSession: RawSessionListRow | RawSessionRecord;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
  currentMachineId: string | null;
  currentMachineHost?: string | null;
  localAttachmentInfo: TerminalAttachmentInfo | null;
  insideTmux: boolean;
  currentTmuxSocketPath?: string | null;
  resolveExecutionSurfaces: (backendId: string) => Promise<BackendExecutionSurfaces>;
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
  const metadata = asRecord(tryDecryptSessionOwnerMetadataView({
    credentials: params.credentials,
    rawSession: params.rawSession,
    accountEncryptionMode: params.accountEncryptionMode,
  }));
  const agentId = resolveAgentId(metadata);

  if (!metadata) {
    return {
      eligible: false,
      agentId,
      reasonCode: params.rawSession.active === true ? 'metadata_unavailable' : 'inactive',
      reason: params.rawSession.active === true ? 'Failed to decrypt session metadata.' : 'Session is not active and cannot be attached.',
      metadata: null,
    };
  }

  const sessionMachineId = readMachineId(metadata);
  const sessionHost = readHost(metadata);
  const hasLocalTerminalEvidence = params.localAttachmentInfo !== null;
  const hasSyncedTerminalMetadata = asRecord(metadata?.terminal) !== null;
  const sessionId = resolveSessionId(params.rawSession);
  const sameMachineIdentity = Boolean(sessionMachineId && params.currentMachineId && sessionMachineId === params.currentMachineId);
  const sameHostAsCurrentMachine = compareMachineHosts(sessionHost, params.currentMachineHost ?? null);
  const recordedTerminal = params.localAttachmentInfo?.terminal ?? asRecord(metadata.terminal);
  const recordedHerdr = asRecord(recordedTerminal?.herdr);
  const hasLocalHerdrRestorationCandidate = recordedTerminal?.mode === 'herdr'
    && asRecord(recordedTerminal.controlServiceabilityV1)?.retired !== true
    && typeof recordedHerdr?.paneId === 'string' && recordedHerdr.paneId.trim().length > 0
    && (hasLocalTerminalEvidence || Boolean(sessionMachineId && (sameMachineIdentity || sameHostAsCurrentMachine)));
  if (params.rawSession.active !== true) {
    // A recorded local pane can activate Herdr's own deferred resume. It is
    // placement intent only; opening it does not admit a Session/controller.
    if (hasLocalHerdrRestorationCandidate) {
      return buildTerminalAttachEligibility({
        metadata, localAttachmentInfo: params.localAttachmentInfo,
        insideTmux: params.insideTmux,
        currentTmuxSocketPath: params.currentTmuxSocketPath ?? null,
      });
    }
    return {
      eligible: false, agentId, reasonCode: 'inactive',
      reason: 'Session is not active and cannot be attached.', metadata,
    };
  }
  if (params.localAttachmentInfo) {
    const hosted = buildTerminalAttachEligibility({
      metadata,
      localAttachmentInfo: params.localAttachmentInfo,
      insideTmux: params.insideTmux,
      currentTmuxSocketPath: params.currentTmuxSocketPath ?? null,
    });
    if (hosted.eligible) return hosted;
  }
  const owner = createSessionOwnerMetadataV1({ metadata });
  const localControl = owner.ok ? owner.ownerMetadata.runtime?.agentRuntimeCapabilitiesV1?.localControl : null;
  const selectedTerminal = owner.ok ? owner.ownerMetadata.runtime?.terminal : null;
  const selectedHost = selectedTerminal?.mode === 'plain' ? selectedTerminal.requested : selectedTerminal?.mode;
  if (agentId && selectedTerminal && localControl?.supported === true && localControl.topology === 'shared'
    && localControl.attachStrategy === 'provider_attach' && metadata.startedBy === 'daemon' && sameMachineIdentity
    && (selectedHost === 'tmux' || selectedHost === 'zellij' || selectedHost === 'herdr')) {
    // The controller's Switch owner prepares the selected presentation. Merely
    // having an independent native attach surface is not managed custody.
    return { eligible: true, agentId, attachStrategy: 'managed_provider_attach', attachScope: 'local',
      terminal: selectedTerminal, metadata };
  }
  const backendId = resolveCliSessionAttachBackendId(metadata);
  const backendExecutionSurfaces = backendId
    ? await params.resolveExecutionSurfaces(backendId)
    : null;
  const providerAttachSurface = backendExecutionSurfaces?.attach ?? null;
  if (providerAttachSurface) {
    const providerBackendId = backendId;
    const catalogAgentId = agentId;
    if (!providerBackendId || !catalogAgentId || !sessionId) {
      return {
        eligible: false,
        agentId: catalogAgentId,
        reasonCode: 'provider_attach_unavailable',
        reason: 'Provider attach is not available for this session.',
        metadata,
      };
    }

    const attachMetadata = buildAttachSessionMetadata(metadata);
    const availability = await providerAttachSurface.evaluateAvailability?.({
      operation: 'attach',
      sessionId,
      metadata: attachMetadata,
      currentMachineId: params.currentMachineId,
      sessionMachineId,
      hasLocalAttachmentInfo: params.localAttachmentInfo !== null,
      depth: 'metadata',
    });
    if (availability?.available === false) {
      return {
        eligible: false,
        agentId: catalogAgentId,
        reasonCode: 'provider_attach_unavailable',
        reason: availability.safeMessage ?? 'Provider attach is not available for this session.',
        metadata,
      };
    }

    return {
      eligible: true,
      agentId: catalogAgentId,
      backendId: providerBackendId,
      attachStrategy: 'provider_attach',
      attachScope: resolveProviderAttachScope({
        currentMachineId: params.currentMachineId,
        sessionMachineId,
        hasLocalAttachmentInfo: params.localAttachmentInfo !== null,
      }),
      metadata: attachMetadata,
    };
  }

  const terminalRuntimeOps = backendExecutionSurfaces?.terminalRuntime ?? null;

  if (hasLocalTerminalEvidence || (hasSyncedTerminalMetadata && sessionMachineId && (sameMachineIdentity || sameHostAsCurrentMachine))) {
    return buildTerminalAttachEligibility({
      metadata,
      localAttachmentInfo: params.localAttachmentInfo,
      insideTmux: params.insideTmux,
      currentTmuxSocketPath: params.currentTmuxSocketPath ?? null,
    });
  }

  if (!params.currentMachineId && !params.localAttachmentInfo) {
    return {
      eligible: false,
      agentId,
      reasonCode: 'current_machine_unknown',
      reason: 'Current machine id is unavailable; cannot determine whether this session belongs to this computer.',
      metadata,
    };
  }
  if (!sessionMachineId && !params.localAttachmentInfo) {
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

  if (!terminalRuntimeOps) {
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
