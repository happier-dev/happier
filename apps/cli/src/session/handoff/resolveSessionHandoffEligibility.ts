import {
  resolveAgentIdFromSessionMetadata,
  type HandoffExportSessionMetadataV1,
} from '@happier-dev/agents';
import type { LinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistryTypes';

type SessionStorageMode = 'direct' | 'persisted';

export type SessionHandoffEligibility =
  | Readonly<{
      eligible: true;
      agentId: CatalogAgentId;
      /** Generation-bound backend selected from the current catalog contribution. */
      backendId: string;
      storageMode: SessionStorageMode;
      sourceMachineId: string;
      vendorHandoffId: string;
    }>
  | Readonly<{
      eligible: false;
      reasonCode:
        | 'agent_unknown'
        | 'source_machine_missing'
        | 'storage_mode_unsupported'
        | 'handoff_unsupported'
        | 'vendor_handoff_id_missing'
        | 'experimental_disabled'
        | 'backend_disabled_by_account_settings'
        | 'linked_session_invalid'
        | 'linked_session_reconciliation_required';
      agentId?: CatalogAgentId;
      storageMode?: SessionStorageMode;
    }>;

type HandoffRuntimeResolution = Readonly<{
  /** Resolves the exact current Agent contribution and its generation-bound runtime surfaces. */
  resolveCurrentExecutionSurfacesForAgent?: (
    agentId: CatalogAgentId,
  ) => Promise<Readonly<{
    backendId: string;
    executionSurfaces: BackendExecutionSurfaces;
  }> | null>;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export async function resolveSessionHandoffEligibility(input: Readonly<{
  metadata: HandoffExportSessionMetadataV1;
  sourceMachineId: unknown;
  externalSessionLinkAuthority: LinkedExternalSessionAuthorityV1;
  /** Host-only identity derived from the full Session metadata before Agent projection. */
  sessionAgentId?: CatalogAgentId | null;
  /** Host-owned native Session identity derived before Agent metadata projection. */
  sessionProviderSessionId?: string | null;
}> & HandoffRuntimeResolution): Promise<SessionHandoffEligibility> {
  const metadata = asRecord(input.metadata);
  if (!metadata) {
    return { eligible: false, reasonCode: 'agent_unknown' };
  }

  // Storage authority is not re-derived here: an unresolved link is refused by
  // the single protocol owner before it can be read as "hosted with us".
  const externalSessionLinkAuthority = input.externalSessionLinkAuthority;
  if (!externalSessionLinkAuthority.ok) {
    return {
      eligible: false,
      reasonCode: externalSessionLinkAuthority.error,
    };
  }
  const externalSessionLink = externalSessionLinkAuthority.transcriptStorage === 'direct'
    ? externalSessionLinkAuthority.linkedSession
    : null;
  const sessionAgentId = typeof input.sessionAgentId === 'string'
    ? input.sessionAgentId.trim() || null
    : null;
  const agentId = externalSessionLink?.agentId
    ?? sessionAgentId
    ?? resolveAgentIdFromSessionMetadata(metadata);
  if (!agentId) {
    return { eligible: false, reasonCode: 'agent_unknown' };
  }

  const sourceMachineId = typeof input.sourceMachineId === 'string'
    ? input.sourceMachineId.trim()
    : '';
  if (!sourceMachineId) {
    return { eligible: false, reasonCode: 'source_machine_missing' };
  }

  const storageMode: SessionStorageMode = externalSessionLinkAuthority.transcriptStorage;
  const vendorHandoffId = typeof input.sessionProviderSessionId === 'string'
    ? input.sessionProviderSessionId.trim()
    : externalSessionLink?.remoteSessionId.trim() ?? '';
  if (!vendorHandoffId) {
    return {
      eligible: false,
      reasonCode: 'vendor_handoff_id_missing',
      agentId,
      storageMode,
    };
  }

  try {
    const runtime = await input.resolveCurrentExecutionSurfacesForAgent?.(agentId);
    const handoff = runtime?.executionSurfaces.handoff;
    if (!runtime || !handoff) {
      return {
        eligible: false,
        reasonCode: 'handoff_unsupported',
        agentId,
        storageMode,
      };
    }
    const availability = await handoff.evaluateAvailability?.({
      operation: 'exportBundle',
      sessionId: vendorHandoffId,
      metadata: input.metadata,
      transcriptStorage: storageMode,
    });
    if (availability?.available === false) {
      return {
        eligible: false,
        reasonCode: availability.reasonCode === 'provider_setting_disabled'
          ? 'experimental_disabled'
          : 'handoff_unsupported',
        agentId,
        storageMode,
      };
    }
    return {
      eligible: true,
      agentId,
      backendId: runtime.backendId,
      storageMode,
      sourceMachineId,
      vendorHandoffId,
    };
  } catch {
    // Runtime reloading and plugin failures are not handoff authorization. Do
    // not retain a stale surface or substitute a bundled Agent's operations.
    return {
      eligible: false,
      reasonCode: 'handoff_unsupported',
      agentId,
      storageMode,
    };
  }
}
