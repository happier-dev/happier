import type { StoredCredentials } from '@/persistence';
import {
  buildBackendTargetKeyV2,
  ProviderBoundModelRefSchema,
  ProviderConnectionIdSchema,
  SessionModelSelectionResolutionError,
  SessionModelTransitionResultV1Schema,
  type ProviderConnectionId,
  type ProviderBoundModelRef,
  type SessionModelTransitionResultV1,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  resolveAmbientProviderConnectionForModelIntent,
  resolveModelSelectionIntentFromSessionMetadata,
} from '@happier-dev/agents';
import {
  createModelIntentMetadataCasCandidate,
  runModelIntentAtAuthoritativeDisposition,
} from '@happier-dev/agents/session/state/metadataWriters';

import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';

import {
  resolveSessionTransportContext,
  type ResolveSessionTransportContextResult,
} from './resolveSessionTransportContext';

type SetSessionModelLookupFailure = Readonly<Extract<
  ResolveSessionTransportContextResult,
  Readonly<{ ok: false }>
>>;

type SetSessionModelActiveResult = SessionModelTransitionResultV1 & Readonly<{
  sessionId: string;
}>;

type SetSessionModelInactiveResult = Readonly<{
  ok: true;
  status: 'intent_updated';
  sessionId: string;
  selection: ProviderBoundModelRef;
  updatedAt: number;
  metadata: Record<string, unknown>;
  version: number;
}>;

export type SetSessionModelResult =
  | SetSessionModelLookupFailure
  | SetSessionModelActiveResult
  | SetSessionModelInactiveResult;

type ResolvedSessionTransportContext = Extract<
  ResolveSessionTransportContextResult,
  Readonly<{ ok: true }>
>;

function resolveRequestedSelection(params: Readonly<{
  sessionTarget: ResolvedSessionTransportContext;
  credentials: StoredCredentials;
  modelId: string;
  hasExplicitProviderConnectionId: boolean;
  explicitProviderConnectionId: ProviderConnectionId | null;
}>): Readonly<{
  selection: ProviderBoundModelRef;
  currentSelection: ProviderBoundModelRef;
}> | null {
  const metadata = tryDecryptSessionOwnerMetadataView({
    credentials: params.credentials,
    rawSession: params.sessionTarget.rawSession,
    accountEncryptionMode: params.sessionTarget.accountEncryptionCurrentness.mode,
  });
  if (!metadata) return null;
  const backendTarget = resolveBackendTargetFromSessionMetadata(metadata);
  if (!backendTarget) {
    throw new SessionModelSelectionResolutionError(
      'model_selection_agent_target_unknown',
    );
  }
  const agentTargetKey = buildBackendTargetKeyV2(backendTarget);
  const currentIntent = resolveModelSelectionIntentFromSessionMetadata(
    metadata,
    agentTargetKey,
  );
  const currentSelection: ProviderBoundModelRef =
    currentIntent?.selection ?? {
      agentTargetKey,
      providerConnectionId: null,
      modelId: 'default',
    };
  let providerConnectionId: string | null;
  if (params.hasExplicitProviderConnectionId) {
    providerConnectionId = params.explicitProviderConnectionId;
  } else {
    const ambient = resolveAmbientProviderConnectionForModelIntent({
      metadata,
      agentTargetKey,
      sessionActive: params.sessionTarget.rawSession.active === true,
    });
    if (ambient.status === 'unreadable') {
      throw new SessionModelSelectionResolutionError(ambient.code);
    }
    providerConnectionId = ambient.providerConnectionId;
  }
  return {
    currentSelection,
    selection: ProviderBoundModelRefSchema.parse({
      agentTargetKey,
      providerConnectionId,
      modelId: params.modelId,
    }),
  };
}

async function invokeActiveModelTransition(params: Readonly<{
  credentials: StoredCredentials;
  sessionTarget: ResolvedSessionTransportContext;
  selection: ProviderBoundModelRef;
}>): Promise<SetSessionModelActiveResult> {
  try {
    const result = SessionModelTransitionResultV1Schema.parse(
      await callSessionRpc({
        token: params.credentials.token,
        ...params.sessionTarget,
        method:
          `${params.sessionTarget.sessionId}:${SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION}`,
        request: { v: 1, selection: params.selection },
      }),
    );
    return { ...result, sessionId: params.sessionTarget.sessionId };
  } catch (error) {
    return {
      ok: false,
      status: 'owner_unavailable',
      sessionId: params.sessionTarget.sessionId,
      activeSelection: null,
      requestedSelection: params.selection,
      reason: error instanceof Error
        ? error.message.slice(0, 512)
          || 'session_model_transition_owner_unavailable'
        : 'session_model_transition_owner_unavailable',
    };
  }
}

export async function setSessionModel(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  modelId: string;
  providerConnectionId?: ProviderConnectionId | string | null;
  /** Retained for caller compatibility; ordering is assigned by the owning CAS/RPC. */
  updatedAt?: number;
}>): Promise<SetSessionModelResult> {
  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
  });
  if (!sessionTarget.ok) {
    return {
      ok: false,
      code: sessionTarget.code,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
    };
  }

  const hasExplicitProviderConnectionId = Object.prototype.hasOwnProperty.call(
    params,
    'providerConnectionId',
  );
  const explicitProviderConnectionId = params.providerConnectionId == null
    ? null
    : ProviderConnectionIdSchema.parse(params.providerConnectionId);
  const request = resolveRequestedSelection({
    sessionTarget,
    credentials: params.credentials,
    modelId: params.modelId.trim(),
    hasExplicitProviderConnectionId,
    explicitProviderConnectionId,
  });
  if (!request) {
    return { ok: false, code: 'unsupported' };
  }

  return await runModelIntentAtAuthoritativeDisposition({
    observedActive: sessionTarget.rawSession.active === true,
    invokeObservedActiveOwner: async () =>
      await invokeActiveModelTransition({
        credentials: params.credentials,
        sessionTarget,
        selection: request.selection,
      }),
    updateInactiveIntent: async () => {
      const candidate = createModelIntentMetadataCasCandidate({
        selection: request.selection,
      });
      const result = await updateSessionMetadataWithRetry({
        token: params.credentials.token,
        credentials: params.credentials,
        sessionId: sessionTarget.sessionId,
        rawSession: sessionTarget.rawSession,
        accountEncryptionCurrentness: sessionTarget.accountEncryptionCurrentness,
        updater: candidate.update,
        sessionExpectation: { kind: 'inactive_model_intent' },
      });
      const candidateState = candidate.readState();
      if (!candidateState.accepted || candidateState.updatedAt === null) {
        return {
          ok: false as const,
          status: 'superseded' as const,
          sessionId: sessionTarget.sessionId,
          activeSelection: request.currentSelection,
          requestedSelection: request.selection,
          reason: 'accepted_intent_was_superseded',
        };
      }
      return {
        ok: true as const,
        status: 'intent_updated' as const,
        sessionId: sessionTarget.sessionId,
        selection: request.selection,
        updatedAt: candidateState.updatedAt,
        metadata: result.metadata,
        version: result.version,
      };
    },
    resolveAndInvokeActiveOwnerAfterConflict: async () => {
      const refreshedTarget = await resolveSessionTransportContext({
        credentials: params.credentials,
        idOrPrefix: sessionTarget.sessionId,
      });
      if (!refreshedTarget.ok || refreshedTarget.rawSession.active !== true) {
        return {
          ok: false as const,
          status: 'owner_unavailable' as const,
          sessionId: sessionTarget.sessionId,
          activeSelection: null,
          requestedSelection: request.selection,
          reason: 'session_model_transition_owner_unproven',
        };
      }
      const refreshedRequest = resolveRequestedSelection({
        sessionTarget: refreshedTarget,
        credentials: params.credentials,
        modelId: params.modelId.trim(),
        hasExplicitProviderConnectionId,
        explicitProviderConnectionId,
      });
      if (!refreshedRequest) {
        return {
          ok: false as const,
          status: 'owner_unavailable' as const,
          sessionId: sessionTarget.sessionId,
          activeSelection: null,
          requestedSelection: request.selection,
          reason: 'session_model_transition_owner_metadata_unavailable',
        };
      }
      return await invokeActiveModelTransition({
        credentials: params.credentials,
        sessionTarget: refreshedTarget,
        selection: refreshedRequest.selection,
      });
    },
  });
}
