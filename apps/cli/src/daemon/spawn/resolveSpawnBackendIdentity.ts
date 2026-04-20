import type { BackendTargetRefV2 } from '@happier-dev/protocol';
import type { SessionAttachFilePayload } from '@/agent/runtime/sessionAttachPayload';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/backends/types';
import {
  normalizeDaemonBackendTargetV2Input,
  resolveDaemonCatalogAgentIdFromBackendTarget,
} from '../backendTargetRouting';
import { readCredentials, type Credentials } from '@/persistence';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import {
  resolveExistingSessionAttachContext,
  type ExistingSessionAttachContextFailureReason,
} from '../sessionEncryption/resolveExistingSessionAttachContext';
import {
  resolveConcreteCompatBackendTargetRefs,
} from '@/session/backendTargets/resolveConcreteBackendTargetRefs';

function isConcreteBuiltInCatalogAgentId(value: string): value is CatalogAgentId {
  return value !== 'customAcp' && (CATALOG_AGENT_IDS as readonly string[]).includes(value);
}

function mapExistingSessionAttachFailureToSpawnError(reason: ExistingSessionAttachContextFailureReason): SpawnSessionResult {
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
  }
}

function resolveBackendTargetFromLocalHandoffOverlay(metadata: Record<string, unknown> | null): BackendTargetRefV2 | null {
  const handoff = metadata?.handoffV1;
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) {
    return null;
  }

  const providerIdValue = 'providerId' in handoff ? (handoff as { providerId?: unknown }).providerId : null;
  const providerId = typeof providerIdValue === 'string' ? providerIdValue.trim() : '';
  if (!providerId) {
    return null;
  }

  if (providerId.startsWith('acp:')) {
    const backendId = providerId.slice(4).trim();
    return backendId
      ? resolveConcreteCompatBackendTargetRefs({
          kind: 'configuredAcpBackend',
          backendId,
        })?.backendTargetV2 ?? null
      : null;
  }

  if (isConcreteBuiltInCatalogAgentId(providerId)) {
    return resolveConcreteCompatBackendTargetRefs({
      kind: 'builtInAgent',
      agentId: providerId,
    })?.backendTargetV2 ?? null;
  }

  return null;
}

type ResolveSpawnBackendIdentitySuccess = Readonly<{
  ok: true;
  normalizedExistingSessionId: string;
  effectiveResume: string;
  effectiveBackendTargetV2: BackendTargetRefV2;
  sessionAttachPayload: SessionAttachFilePayload | null;
  catalogAgentId: CatalogAgentId | null;
}>;

type ResolveSpawnBackendIdentityFailure = Readonly<{
  ok: false;
  error: SpawnSessionResult;
}>;

export async function resolveSpawnBackendIdentity(params: Readonly<{
  existingSessionId: string;
  resume: string;
  backendTarget: BackendTargetRefV2 | undefined;
  credentials: Credentials | null;
  loadLocalHandoffMetadataByVendorResumeId: (vendorResumeId: string) => Promise<Record<string, unknown> | null>;
}>): Promise<ResolveSpawnBackendIdentitySuccess | ResolveSpawnBackendIdentityFailure> {
  const normalizedExistingSessionId = params.existingSessionId.trim();
  let effectiveResume = params.resume.trim();
  const hasBackendTargetInput = params.backendTarget !== undefined;
  let effectiveBackendTargetV2 = normalizeDaemonBackendTargetV2Input(params.backendTarget);
  let sessionAttachPayload: SessionAttachFilePayload | null = null;

  if (normalizedExistingSessionId) {
    const effectiveCredentials = params.credentials ?? (await readCredentials().catch(() => null));
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
    if (attachContext.backendTarget) {
      const attachedBackendTarget = resolveConcreteCompatBackendTargetRefs(attachContext.backendTarget);
      if (attachedBackendTarget) {
        effectiveBackendTargetV2 = attachedBackendTarget.backendTargetV2;
      }
    }
    if (!effectiveResume) {
      const derivedResume = typeof attachContext.vendorResumeId === 'string' ? attachContext.vendorResumeId.trim() : '';
      if (derivedResume) {
        effectiveResume = derivedResume;
      }
    }
    if (!effectiveBackendTargetV2 && effectiveResume) {
      const localHandoffMetadataOverlay = await params.loadLocalHandoffMetadataByVendorResumeId(effectiveResume).catch(() => null);
      const localHandoffBackendTarget = resolveBackendTargetFromLocalHandoffOverlay(localHandoffMetadataOverlay);
      if (localHandoffBackendTarget) {
        effectiveBackendTargetV2 = localHandoffBackendTarget;
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
          ? 'Unknown backend target'
          : 'Backend target is required for fresh session spawn.',
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
  };
}
