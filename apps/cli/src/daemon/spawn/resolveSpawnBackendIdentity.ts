import {
  type AgentExecutionTargetV1,
  type BackendTargetRefV2,
  type SessionOwnerMetadataV1,
} from '@happier-dev/protocol';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { AgentExecutionTargetV1Schema, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
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
  type ExistingSessionAttachContextFailure,
} from '../sessionEncryption/resolveExistingSessionAttachContext';
import { resolveConcreteCompatBackendTargetRefs } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import { resolveCurrentAgentRouting } from '@/api/session/external/linking/qualifiedLinkIdentityRegistry';
import { projectResolvedAgentBackendTarget } from '@/session/creation/resolveSessionCreationAgentTarget';

export function mapExistingSessionAttachFailureToSpawnError(
  failure: ExistingSessionAttachContextFailure,
): Extract<SpawnSessionResult, { type: 'error' }> {
  const { reason } = failure;
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
        errorDetail: {
          kind: 'launch_error',
          code: failure.diagnostic?.errorCode ?? 'session_detail_fetch_failed',
          message: 'The Session detail needed for launch could not be read.',
        },
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
  effectiveAgentTarget: AgentExecutionTargetV1 | undefined;
  sessionAttachPayload: SessionAttachFilePayload | null;
  catalogAgentId: CatalogAgentId | null;
  ownerMetadata: SessionOwnerMetadataV1 | null;
  existingSessionWorkspacePath: string | null;
}>;

type ResolveSpawnBackendIdentityFailure = Readonly<{
  ok: false;
  error: SpawnSessionResult;
}>;

async function resolveSpawnAgentRouting(identity: AgentExecutionTargetV1['identity']): Promise<
  Readonly<{ ok: true; routingId: string }> | ResolveSpawnBackendIdentityFailure
> {
  const resolution = await resolveCurrentAgentRouting(identity);
  if (resolution.kind === 'available') return { ok: true, routingId: resolution.routingId };
  if (resolution.kind === 'unavailable') {
    const message = resolution.code === 'plugin_disabled'
      ? 'This Agent plugin is disabled. Re-enable it in Plugins to resume this Session.'
      : 'Account plugin execution is unavailable.';
    return { ok: false, error: { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: message, errorDetail: { kind: 'launch_error', code: resolution.code, message } } };
  }
  return { ok: false, error: { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    errorMessage: 'Selected Agent is not installed or unavailable' } };
}

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
  const hasBackendTargetInput = params.backendTarget !== undefined;
  const compatibilityBackendTarget = normalizeDaemonBackendTargetV2Input(params.backendTarget);
  const requestedAgentTarget = params.agentTarget ?? (compatibilityBackendTarget?.sourceKind === 'configured'
    ? { kind: 'agent' as const, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
      definitionId: compatibilityBackendTarget.configuredBackendId ?? compatibilityBackendTarget.backendId }
    : undefined);
  const parsedAgentTarget = requestedAgentTarget === undefined ? null : AgentExecutionTargetV1Schema.safeParse(requestedAgentTarget);
  if (parsedAgentTarget && !parsedAgentTarget.success) {
    return { ok: false, error: { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Selected Agent target is incomplete or invalid' } };
  }
  let effectiveAgentTarget = parsedAgentTarget?.success ? parsedAgentTarget.data : undefined;
  const routing = effectiveAgentTarget
    ? await resolveSpawnAgentRouting(effectiveAgentTarget.identity)
    : null;
  if (routing?.ok === false) return routing;
  const resolvedAgentRoutingId = routing?.routingId ?? null;
  if (
    resolvedAgentRoutingId
    && compatibilityBackendTarget
    && (
      compatibilityBackendTarget.sourceKind === 'configured'
        ? (compatibilityBackendTarget.configuredBackendId ?? compatibilityBackendTarget.backendId) !== effectiveAgentTarget?.definitionId
        : compatibilityBackendTarget.backendId !== resolvedAgentRoutingId
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
  let effectiveBackendTargetV2 = resolvedAgentRoutingId && effectiveAgentTarget
    ? projectResolvedAgentBackendTarget(effectiveAgentTarget, resolvedAgentRoutingId)
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
        error: mapExistingSessionAttachFailureToSpawnError(attachContext),
      };
    }

    sessionAttachPayload = attachContext.attachPayload;
    ownerMetadata = attachContext.ownerMetadata ?? null;
    existingSessionWorkspacePath =
      attachContext.existingSessionWorkspacePath ?? null;
    if (!requestedAgentTarget && attachContext.backendTarget) {
      const attachedBackendTarget = resolveConcreteCompatBackendTargetRefs(attachContext.backendTarget);
      if (attachedBackendTarget) {
        effectiveBackendTargetV2 = attachedBackendTarget.backendTargetV2;
        if (effectiveBackendTargetV2.sourceKind === 'configured') {
          effectiveAgentTarget = AgentExecutionTargetV1Schema.parse({ kind: 'agent',
            identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
            definitionId: effectiveBackendTargetV2.configuredBackendId ?? effectiveBackendTargetV2.backendId });
          const attachedRouting = await resolveSpawnAgentRouting(effectiveAgentTarget.identity);
          if (attachedRouting.ok === false) return attachedRouting;
          effectiveBackendTargetV2 = projectResolvedAgentBackendTarget(effectiveAgentTarget, attachedRouting.routingId);
        }
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
    effectiveAgentTarget,
    sessionAttachPayload,
    catalogAgentId,
    ownerMetadata,
    existingSessionWorkspacePath,
  };
}
