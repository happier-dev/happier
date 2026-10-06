import {
  type AgentExecutionTargetV1,
  type BackendTargetRefV2,
  type SessionOwnerMetadataV1,
} from '@happier-dev/protocol';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { SessionAttachFilePayload } from '@/agent/runtime/sessionAttachPayload';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import {
  normalizeDaemonBackendTargetV2Input,
  resolveDaemonCatalogAgentIdFromBackendTarget,
} from '../backendTargetRouting';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import {
  resolveExistingSessionAttachContext,
  type ExistingSessionAttachContextFailureReason,
} from '../sessionEncryption/resolveExistingSessionAttachContext';
import { resolveConcreteCompatBackendTargetRefs } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import { resolveCurrentExternalSessionAgentRoutingId } from '@/api/session/external/linking/qualifiedLinkIdentityRegistry';

export function mapExistingSessionAttachFailureToSpawnError(
  reason: ExistingSessionAttachContextFailureReason,
): Extract<SpawnSessionResult, { type: 'error' }> {
  switch (reason) {
    case 'missingSessionId':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Existing session id is required for resume attach.',
      };
    case 'missingToken':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Missing auth token to fetch existing session for resume.',
      };
    case 'sessionNotFound':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Existing session not found or access denied for resume.',
      };
    case 'fetchFailed':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Failed to fetch existing session for resume.',
      };
    case 'missingCredentials':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
        errorMessage: 'Missing credentials to open the session encryption key for resume.',
      };
    case 'invalidEncryptionKey':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
        errorMessage: 'Failed to open session encryption key for resume.',
      };
    case 'invalidOwnerMetadata':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'Owner session metadata is unavailable for resume.',
      };
    case 'linkedResumeIdentityUnavailable':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'Linked session Agent identity is unavailable for resume.',
      };
    case 'clientE2eeRequired':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'This daemon requires end-to-end encryption and will not attach to a plaintext session.',
      };
  }
}

type ResolveSpawnBackendIdentitySuccess = Readonly<{
  ok: true;
  normalizedExistingSessionId: string;
  effectiveResume: string;
  effectiveBackendTargetV2: BackendTargetRefV2;
  sessionAttachPayload: SessionAttachFilePayload | null;
  catalogAgentId: CatalogAgentId | null;
  ownerMetadata: SessionOwnerMetadataV1 | null;
  existingSessionWorkspacePath: string | null;
}>;

type ResolveSpawnBackendIdentityFailure = Readonly<{
  ok: false;
  error: SpawnSessionResult;
}>;

export async function resolveSpawnBackendIdentity(params: Readonly<{
  existingSessionId: string;
  resume: string;
  agentTarget: AgentExecutionTargetV1 | undefined;
  backendTarget: BackendTargetRefV2 | undefined;
  credentials: StoredCredentials | null;
}>): Promise<ResolveSpawnBackendIdentitySuccess | ResolveSpawnBackendIdentityFailure> {
  const normalizedExistingSessionId = params.existingSessionId.trim();
  // Opaque Agent identity: presence is decided, bytes are never rewritten.
  let effectiveResume = readNonBlankOpaqueIdentifier(params.resume) ?? '';
  const resolvedAgentRoutingId = params.agentTarget
    ? await resolveCurrentExternalSessionAgentRoutingId(params.agentTarget.identity)
    : null;
  if (params.agentTarget && !resolvedAgentRoutingId) {
    return {
      ok: false,
      error: {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Selected Agent is not installed or unavailable',
      },
    };
  }
  const hasBackendTargetInput = params.backendTarget !== undefined;
  const compatibilityBackendTarget = normalizeDaemonBackendTargetV2Input(params.backendTarget);
  if (
    resolvedAgentRoutingId
    && compatibilityBackendTarget
    && (
      compatibilityBackendTarget.sourceKind === 'configured'
      || compatibilityBackendTarget.backendId !== resolvedAgentRoutingId
    )
  ) {
    return {
      ok: false,
      error: {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Agent target does not match compatibility backend target',
      },
    };
  }
  let effectiveBackendTargetV2 = resolvedAgentRoutingId
    ? {
        kind: 'backend' as const,
        backendId: resolvedAgentRoutingId,
        sourceKind: 'built_in' as const,
      }
    : compatibilityBackendTarget;
  let sessionAttachPayload: SessionAttachFilePayload | null = null;
  let ownerMetadata: SessionOwnerMetadataV1 | null = null;
  let existingSessionWorkspacePath: string | null = null;

  if (normalizedExistingSessionId) {
    const effectiveCredentials = params.credentials ?? (await readStoredCredentials().catch(() => null));
    const tokenForFetch = effectiveCredentials?.token ?? '';

    const attachContext = await resolveExistingSessionAttachContext({
      token: tokenForFetch,
      sessionId: normalizedExistingSessionId,
      credentials: effectiveCredentials,
    });

    if (attachContext.ok === false) {
      const { reason } = attachContext;
      return {
        ok: false,
        error: mapExistingSessionAttachFailureToSpawnError(reason),
      };
    }

    sessionAttachPayload = attachContext.attachPayload;
    ownerMetadata = attachContext.ownerMetadata ?? null;
    existingSessionWorkspacePath =
      attachContext.existingSessionWorkspacePath ?? null;
    if (!params.agentTarget && attachContext.backendTarget) {
      const attachedBackendTarget = resolveConcreteCompatBackendTargetRefs(attachContext.backendTarget);
      if (attachedBackendTarget) {
        effectiveBackendTargetV2 = attachedBackendTarget.backendTargetV2;
      }
    }
    const linkedVendorResumeId = readNonBlankOpaqueIdentifier(attachContext.linkedVendorResumeId) ?? '';
    if (linkedVendorResumeId) {
      effectiveResume = linkedVendorResumeId;
    } else if (!effectiveResume) {
      const derivedResume = readNonBlankOpaqueIdentifier(attachContext.vendorResumeId) ?? '';
      if (derivedResume) {
        effectiveResume = derivedResume;
      }
    }
  }

  if (!effectiveBackendTargetV2) {
    return {
      ok: false,
      error: {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: hasBackendTargetInput || normalizedExistingSessionId
          ? 'Unknown Agent or backend target'
          : 'Agent target is required for fresh session spawn.',
      },
    };
  }

  const catalogAgentId = resolveDaemonCatalogAgentIdFromBackendTarget(effectiveBackendTargetV2);
  if (!catalogAgentId && effectiveBackendTargetV2.sourceKind !== 'configured') {
    return {
      ok: false,
      error: {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unknown backend target',
      },
    };
  }

  const resolvedBackendTargetV2 = effectiveBackendTargetV2;

  return {
    ok: true,
    normalizedExistingSessionId,
    effectiveResume,
    effectiveBackendTargetV2: resolvedBackendTargetV2,
    sessionAttachPayload,
    catalogAgentId,
    ownerMetadata,
    existingSessionWorkspacePath,
  };
}
