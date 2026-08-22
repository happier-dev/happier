import {
  evaluateVendorHandoffEligibility,
  isBundledAgentId,
  resolveAgentIdFromSessionMetadata,
  type HandoffExportSessionMetadataV1,
} from '@happier-dev/agents';
import type { LinkedExternalSessionMetadataResolutionV1 } from '@happier-dev/protocol';
import { resolveSessionRuntimeIdentityFallback } from '@/agent/runtime/identity';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistryTypes';

type SessionStorageMode = 'direct' | 'persisted';

export type SessionHandoffEligibility =
  | Readonly<{
      eligible: true;
      agentId: CatalogAgentId;
      /** The exact current runtime target for an installed external Agent. */
      backendId?: string;
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
  /** Resolves an exact current Agent contribution to its generation-bound runtime surfaces. */
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

function readProjectedProviderSessionId(
  metadata: HandoffExportSessionMetadataV1,
): string | null {
  if (typeof metadata.providerSessionId !== 'string') return null;
  const providerSessionId = metadata.providerSessionId.trim();
  return providerSessionId || null;
}

function buildVendorEligibilityMetadata(
  metadata: Record<string, unknown>,
  runtimeDescriptorV1: unknown,
): Record<string, unknown> {
  if (asRecord(metadata.runtimeDescriptorV1)) {
    return metadata;
  }
  if (!asRecord(runtimeDescriptorV1)) {
    return metadata;
  }
  return {
    ...metadata,
    runtimeDescriptorV1,
  };
}

async function resolveExternalSessionHandoffEligibility(input: Readonly<{
  agentId: CatalogAgentId;
  storageMode: SessionStorageMode;
  sourceMachineId: string;
  vendorHandoffId: string | null;
  metadata: HandoffExportSessionMetadataV1;
}> & HandoffRuntimeResolution): Promise<SessionHandoffEligibility> {
  const vendorHandoffId = input.vendorHandoffId?.trim() ?? '';
  if (!vendorHandoffId) {
    return {
      eligible: false,
      reasonCode: 'vendor_handoff_id_missing',
      agentId: input.agentId,
      storageMode: input.storageMode,
    };
  }

  try {
    const runtime = await input.resolveCurrentExecutionSurfacesForAgent?.(input.agentId);
    if (!runtime) {
      return {
        eligible: false,
        reasonCode: 'handoff_unsupported',
        agentId: input.agentId,
        storageMode: input.storageMode,
      };
    }
    const handoff = runtime.executionSurfaces.handoff;
    if (!handoff) {
      return {
        eligible: false,
        reasonCode: 'handoff_unsupported',
        agentId: input.agentId,
        storageMode: input.storageMode,
      };
    }
    const availability = await handoff.evaluateAvailability?.({
      operation: 'exportBundle',
      sessionId: vendorHandoffId,
      metadata: input.metadata,
    });
    if (availability?.available === false) {
      return {
        eligible: false,
        reasonCode: 'handoff_unsupported',
        agentId: input.agentId,
        storageMode: input.storageMode,
      };
    }
    return {
      eligible: true,
      agentId: input.agentId,
      backendId: runtime.backendId,
      storageMode: input.storageMode,
      sourceMachineId: input.sourceMachineId,
      vendorHandoffId,
    };
  } catch {
    // Runtime reloading and plugin failures are not handoff authorization. Do
    // not retain a stale surface or substitute a bundled Agent's operations.
    return {
      eligible: false,
      reasonCode: 'handoff_unsupported',
      agentId: input.agentId,
      storageMode: input.storageMode,
    };
  }
}

export async function resolveSessionHandoffEligibility(input: Readonly<{
  metadata: HandoffExportSessionMetadataV1;
  sourceMachineId: unknown;
  externalSessionLinkResolution: LinkedExternalSessionMetadataResolutionV1;
  /** Host-only identity derived from the full Session metadata before Agent projection. */
  sessionAgentId?: CatalogAgentId | null;
  accountSettings?: Record<string, unknown> | null;
}> & HandoffRuntimeResolution): Promise<SessionHandoffEligibility> {
  const metadata = asRecord(input.metadata);
  if (!metadata) {
    return { eligible: false, reasonCode: 'agent_unknown' };
  }

  const runtimeIdentity = resolveSessionRuntimeIdentityFallback({ metadata });
  const externalSessionLinkResolution = input.externalSessionLinkResolution;
  if (
    !externalSessionLinkResolution.ok
    && externalSessionLinkResolution.error !== 'linked_session_not_found'
  ) {
    return {
      eligible: false,
      reasonCode: externalSessionLinkResolution.error,
    };
  }
  const externalSessionLink = externalSessionLinkResolution.ok
    ? externalSessionLinkResolution.linkedSession
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

  const storageMode: SessionStorageMode = externalSessionLink ? 'direct' : 'persisted';
  // Bundled vendor handoff policy covers bundled Agents; every other installed
  // Agent hands off through its own contributed execution surfaces.
  if (!isBundledAgentId(agentId)) {
    return await resolveExternalSessionHandoffEligibility({
      agentId,
      storageMode,
      sourceMachineId,
      // Handoff callbacks receive the strict Agent-owned projection, not raw
      // session metadata. Its generic providerSessionId is the canonical
      // external Agent identity; preserve the raw-metadata fallback only for
      // compatibility readers that still reach this owner directly.
      vendorHandoffId:
        readProjectedProviderSessionId(input.metadata)
        ?? runtimeIdentity.providerSessionId,
      metadata: input.metadata,
      resolveCurrentExecutionSurfacesForAgent:
        input.resolveCurrentExecutionSurfacesForAgent,
    });
  }

  const vendorEligibilityMetadata = buildVendorEligibilityMetadata(
    metadata,
    runtimeIdentity.runtimeDescriptorV1,
  );
  const vendor = evaluateVendorHandoffEligibility({
    agentId,
    storageMode,
    metadata: vendorEligibilityMetadata,
    accountSettings: input.accountSettings,
  });

  if (!vendor.eligible && vendor.reasonCode === 'vendor_handoff_id_missing' && runtimeIdentity.providerSessionId) {
    return {
      eligible: true,
      agentId,
      storageMode,
      sourceMachineId,
      vendorHandoffId: runtimeIdentity.providerSessionId,
    };
  }

  if (!vendor.eligible) {
    return {
      eligible: false,
      reasonCode: vendor.reasonCode,
      agentId,
      storageMode,
    };
  }

  return {
    eligible: true,
    agentId,
    storageMode,
    sourceMachineId,
    vendorHandoffId: vendor.vendorHandoffId,
  };
}
