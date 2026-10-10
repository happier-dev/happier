import type { ImportedSessionHandoffBundle, SessionHandoffAgentBundle } from '../types';
import { projectSessionMetadataForAgentHandoff, readProviderSessionIdSessionState, resolveAgentIdFromSessionMetadata, type HandoffImportResultV1 } from '@happier-dev/agents';
import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { CurrentCatalogAgentExecutionSurfaces } from '@/agent/runtime/bridges/session/sessionBridgeContract';

import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { applyAgentAuthoredSessionStateUpdatesToMetadata } from '@/agent/runtime/state/agentAuthoredSessionStateUpdates';
import { ExternalSessionsSourceSchema } from '@happier-dev/protocol/sessions/external/sourceCatalog';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';

export type SessionHandoffTypedImportFailureCode =
  | 'target_identity_conflict'
  | 'agent_version_unsupported'
  | 'existing_session_state_unavailable'
  | 'existing_session_state_unsupported';

export class SessionHandoffTypedImportError extends Error {
  readonly code: SessionHandoffTypedImportFailureCode;

  constructor(input: Readonly<{
    code: SessionHandoffTypedImportFailureCode;
    message?: string;
    cause?: unknown;
  }>) {
    super(input.message ?? input.code, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'SessionHandoffTypedImportError';
    this.code = input.code;
  }
}

function readSessionHandoffTypedImportFailureCode(
  error: unknown,
): SessionHandoffTypedImportFailureCode | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as Readonly<{ code?: unknown }>).code;
  return code === 'target_identity_conflict' || code === 'agent_version_unsupported'
    || code === 'existing_session_state_unavailable' || code === 'existing_session_state_unsupported'
    ? code
    : null;
}

export async function importSessionHandoffAgentBundle(params: Readonly<{
  bundle: SessionHandoffAgentBundle;
  targetPath: string;
  sessionStorageMode?: 'direct' | 'persisted';
}>): Promise<ImportedSessionHandoffBundle> {
  const currentRuntime = await getSessionHostBridge()
    .resolveCurrentExecutionSurfacesForCatalogAgent(params.bundle.agentId);
  if (!currentRuntime || currentRuntime.agentId !== params.bundle.agentId) {
    throw new Error(`Unsupported handoff provider: ${params.bundle.agentId}`);
  }
  const providerOps = currentRuntime.executionSurfaces.handoff;
  if (!providerOps) throw new Error(`Unsupported handoff provider: ${params.bundle.agentId}`);
  let imported;
  try {
    imported = await providerOps.importBundle({
      bundle: params.bundle,
      targetDirectory: params.targetPath,
    });
  } catch (error) {
    const code = readSessionHandoffTypedImportFailureCode(error);
    if (code) {
      throw new SessionHandoffTypedImportError({
        code,
        message: error instanceof Error ? error.message : undefined,
        cause: error,
      });
    }
    throw error;
  }
  if (!imported.ok) {
    const typedCode = readSessionHandoffTypedImportFailureCode(imported);
    if (typedCode) {
      throw new SessionHandoffTypedImportError({
        code: typedCode,
        message: imported.message,
      });
    }
    throw new Error(imported.message ?? `Session handoff import failed: ${imported.code}`);
  }
  return projectNativeSessionHandoffState({ value: imported.value, currentRuntime, agentId: params.bundle.agentId,
    targetPath: params.targetPath, sessionStorageMode: params.sessionStorageMode });
}

function projectNativeSessionHandoffState(params: Readonly<{
  value: HandoffImportResultV1;
  currentRuntime: CurrentCatalogAgentExecutionSurfaces;
  agentId: string;
  targetPath: string;
  sessionStorageMode?: 'direct' | 'persisted';
}>): ImportedSessionHandoffBundle {
  const source = ExternalSessionsSourceSchema.parse(params.value.source);
  const metadataPatch = applyAgentAuthoredSessionStateUpdatesToMetadata(
    {},
    params.value.launch.sessionStateUpdates ?? [],
    'handoff.launch.sessionStateUpdates',
  );
  const runtimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(metadataPatch) ?? undefined;
  if (runtimeDescriptorV1 && runtimeDescriptorV1.agentId !== params.agentId) {
    throw new SessionHandoffTypedImportError({
      code: 'target_identity_conflict',
      message: 'Imported runtime descriptor Agent identity does not match the handoff bundle',
    });
  }

  return {
    remoteSessionId: params.value.providerSessionId,
    directSource: source,
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    resume: {
      // The source Agent may report its original machine-local cwd. Target
      // custody owns the already-validated handoff path.
      directory: params.targetPath,
      agent: params.agentId as ImportedSessionHandoffBundle['resume']['agent'],
      agentTarget: params.currentRuntime.agentTarget,
      resume: params.value.providerSessionId,
      ...(params.value.launch.environmentVariables
        ? { environmentVariables: { ...params.value.launch.environmentVariables } }
        : {}),
      transcriptStorage: params.sessionStorageMode === 'persisted' ? 'persisted' : 'direct',
      approvedNewDirectoryCreation: true,
    },
  };
}

/** Read-only native acquisition; the same current Agent seam owns preflight, preparation and launch revalidation. */
export async function resolveExistingSessionHandoffState(params: Readonly<{
  metadata: Record<string, unknown>;
  targetPath: string;
  sessionStorageMode?: 'direct' | 'persisted';
  environmentVariables?: Readonly<Record<string, string>>;
}>): Promise<ImportedSessionHandoffBundle> {
  const agentMetadata = projectSessionMetadataForAgentHandoff(params.metadata);
  const bridge = getSessionHostBridge();
  const eligibility = await bridge.resolveSessionHandoffEligibility({
    metadata: agentMetadata, sourceMachineId: params.metadata.machineId,
    externalSessionLinkAuthority: resolveLinkedExternalSessionAuthorityV1(params.metadata),
    sessionAgentId: resolveAgentIdFromSessionMetadata(params.metadata),
    sessionProviderSessionId: readProviderSessionIdSessionState(params.metadata).value,
  });
  if (!eligibility.eligible) throw new SessionHandoffTypedImportError({ code: 'existing_session_state_unsupported', message: eligibility.reasonCode });
  const currentRuntime = await bridge.resolveCurrentExecutionSurfacesForCatalogAgent(eligibility.agentId);
  const resolveExistingState = currentRuntime?.backendId === eligibility.backendId
    ? currentRuntime.executionSurfaces.handoff?.resolveExistingState : undefined;
  if (!currentRuntime || !resolveExistingState) throw new SessionHandoffTypedImportError({ code: 'existing_session_state_unsupported' });
  const result = await resolveExistingState({ sessionId: eligibility.vendorHandoffId, metadata: agentMetadata,
    targetDirectory: params.targetPath, ...(params.environmentVariables ? { environmentVariables: params.environmentVariables } : {}) });
  if (!result.ok) {
    const code = readSessionHandoffTypedImportFailureCode(result);
    if (code) throw new SessionHandoffTypedImportError({ code, message: result.message });
    throw new Error(result.message ?? `Existing session state verification failed: ${result.code}`);
  }
  if (result.value.providerSessionId !== eligibility.vendorHandoffId) throw new SessionHandoffTypedImportError({ code: 'target_identity_conflict' });
  return projectNativeSessionHandoffState({ value: result.value, currentRuntime, agentId: eligibility.agentId,
    targetPath: params.targetPath, sessionStorageMode: params.sessionStorageMode });
}
