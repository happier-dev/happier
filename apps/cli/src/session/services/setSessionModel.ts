import type { StoredCredentials } from '@/persistence';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ProviderBoundModelRefSchema, SessionModelSelectionResolutionError } from '@happier-dev/protocol/providers/model-selection';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { SessionModelTransitionResultV1Schema } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import { SessionModelSelectionV2Schema } from '@happier-dev/protocol/providers/selection/v2';
import { isModelRefGrantedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { CallerInputConstraintsV1, ProviderConnectionId, ProviderBoundModelRef, SessionModelSelectionV2, SessionModelTransitionResultV1 } from '@happier-dev/protocol';
import { TeamCredentialProviderModelSelectionV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import {
  resolveAmbientProviderConnectionForModelIntent,
  resolveModelSelectionIntentFromSessionMetadata,
} from '@happier-dev/agents';
import {
  createModelIntentMetadataCasCandidate,
  createModelIntentV2MetadataCasCandidate,
  isInactiveModelIntentSessionActiveError,
  runModelIntentAtAuthoritativeDisposition,
} from '@happier-dev/agents/session/state/metadataWriters';

import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  projectPluginFailureMessage,
  projectPluginFailureText,
} from '@/plugins/runtime/lifecycle/utils';

import {
  resolveSessionTransportContext,
  type ResolveSessionTransportContextResult,
} from './resolveSessionTransportContext';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

type SetSessionModelLookupFailure = Readonly<Extract<
  ResolveSessionTransportContextResult,
  Readonly<{ ok: false }>
>>;
type SetSessionModelGrantFailure = Readonly<{ ok: false; code: 'model_not_granted'; sessionId: string }>;

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

type SetSessionTeamModelInactiveResult = Readonly<{
  ok: true;
  status: 'intent_updated';
  sessionId: string;
  selection: SessionModelSelectionV2;
  updatedAt: number;
  metadata: Record<string, unknown>;
  version: number;
}>;

type SetSessionTeamModelFailure = Readonly<{
  ok: false;
  status: 'restart_required' | 'team_resource_active_transition_unsupported';
  sessionId: string;
  reason: 'session_activated_before_team_resource_commit' | 'team_resource_binding_changed';
  requestedTeamSelection?: TeamCredentialProviderModelSelectionV1;
}>;

export type SetSessionModelResult =
  | SetSessionModelLookupFailure
  | SetSessionModelGrantFailure
  | SetSessionModelActiveResult
  | SetSessionModelInactiveResult
  | SetSessionTeamModelInactiveResult
  | SetSessionTeamModelFailure;

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
  callerInputConstraints?: CallerInputConstraintsV1;
  externalAction?: Parameters<typeof callSessionRpc>[0]['externalAction'];
}>): Promise<SetSessionModelActiveResult | SetSessionModelGrantFailure> {
  if (params.callerInputConstraints && !isModelRefGrantedV1(params.callerInputConstraints, params.selection)) {
    return { ok: false, code: 'model_not_granted', sessionId: params.sessionTarget.sessionId };
  }
  try {
    const result = SessionModelTransitionResultV1Schema.parse(
      await callSessionRpc({
        token: params.credentials.token,
        ...params.sessionTarget,
        method:
          `${params.sessionTarget.sessionId}:${SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION}`,
        request: { v: 1, selection: params.selection },
        ...(params.externalAction ? { externalAction: params.externalAction } : {}),
      }),
    );
    const safeResult = !result.ok && result.reason
      ? { ...result, reason: projectPluginFailureMessage(result.reason) }
      : result;
    return { ...safeResult, sessionId: params.sessionTarget.sessionId };
  } catch (error) {
    return {
      ok: false,
      status: 'owner_unavailable',
      sessionId: params.sessionTarget.sessionId,
      activeSelection: null,
      requestedSelection: params.selection,
      reason: projectPluginFailureText(error),
    };
  }
}

export async function setSessionModel(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  modelId?: string;
  providerConnectionId?: ProviderConnectionId | string | null;
  teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
  teamVisibilityGrantConsent?: Readonly<{ teamId: string }>;
  /** Retained for caller compatibility; ordering is assigned by the owning CAS/RPC. */
  updatedAt?: number;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
  callerInputConstraints?: CallerInputConstraintsV1;
  externalAction?: Parameters<typeof callSessionRpc>[0]['externalAction'];
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown;
  }>) => Readonly<Record<string, string>> | null;
}>): Promise<SetSessionModelResult> {
  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
    ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
  });
  if (!sessionTarget.ok) {
    return {
      ok: false,
      code: sessionTarget.code,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
    };
  }

  if (params.teamCredentialModel !== undefined) {
    // Team refs are not encodable in the finite ProviderBoundModelRef grant vocabulary.
    if (params.callerInputConstraints && !isModelRefGrantedV1(params.callerInputConstraints, 'automatic')) {
      return { ok: false, code: 'model_not_granted', sessionId: sessionTarget.sessionId };
    }
    const requested = TeamCredentialProviderModelSelectionV1Schema.parse(params.teamCredentialModel);
    const metadata = tryDecryptSessionOwnerMetadataView({
      credentials: params.credentials,
      rawSession: sessionTarget.rawSession,
      accountEncryptionMode: sessionTarget.accountEncryptionCurrentness.mode,
    });
    if (!metadata) return { ok: false, code: 'unsupported' };
    const backendTarget = resolveBackendTargetFromSessionMetadata(metadata);
    if (!backendTarget || buildBackendTargetKeyV2(backendTarget) !== requested.agentTargetKey) {
      throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
    }
    const observedActive = sessionTarget.rawSession.active === true;
    const candidate = createModelIntentV2MetadataCasCandidate({
      selection: SessionModelSelectionV2Schema.parse({
        v: 2,
        updatedAt: 0,
        ref: {
          source: 'team_resource',
          resourceId: requested.resourceId,
          teamId: requested.teamId,
          expectedResourceRevision: requested.expectedResourceRevision,
          deliveryMode: requested.deliveryMode,
          agentTargetKey: requested.agentTargetKey,
          modelId: requested.modelId,
        },
      }),
    });
    try {
      const result = await updateSessionMetadataWithRetry({
        token: params.credentials.token,
        ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
        credentials: params.credentials,
        sessionId: sessionTarget.sessionId,
        rawSession: sessionTarget.rawSession,
        accountEncryptionCurrentness: sessionTarget.accountEncryptionCurrentness,
        updater: candidate.update,
        sessionExpectation: observedActive ? undefined : { kind: 'inactive_model_intent' },
        teamCredentialBindings: [{
          v: 1,
          slot: { kind: 'provider_model' },
          resourceId: requested.resourceId,
          expectedResourceRevision: requested.expectedResourceRevision,
          deliveryMode: requested.deliveryMode,
          teamId: requested.teamId,
        }],
        teamVisibilityGrantConsent: params.teamVisibilityGrantConsent,
      });
      const state = candidate.readState();
      if (!state.accepted || state.updatedAt === null) {
        return {
          ok: false,
          status: 'team_resource_active_transition_unsupported',
          sessionId: sessionTarget.sessionId,
          reason: 'session_activated_before_team_resource_commit',
        };
      }
      if (observedActive) {
        return {
          ok: false,
          status: 'restart_required',
          sessionId: sessionTarget.sessionId,
          reason: 'team_resource_binding_changed',
          requestedTeamSelection: requested,
        };
      }
      return {
        ok: true,
        status: 'intent_updated',
        sessionId: sessionTarget.sessionId,
        selection: SessionModelSelectionV2Schema.parse({
          v: 2,
          updatedAt: state.updatedAt,
          ref: {
            source: 'team_resource', resourceId: requested.resourceId, teamId: requested.teamId,
            expectedResourceRevision: requested.expectedResourceRevision,
            deliveryMode: requested.deliveryMode,
            agentTargetKey: requested.agentTargetKey, modelId: requested.modelId,
          },
        }),
        updatedAt: state.updatedAt,
        metadata: result.metadata,
        version: result.version,
      };
    } catch (error) {
      if (!isInactiveModelIntentSessionActiveError(error)) throw error;
      return {
        ok: false,
        status: 'team_resource_active_transition_unsupported',
        sessionId: sessionTarget.sessionId,
        reason: 'session_activated_before_team_resource_commit',
      };
    }
  }

  const modelId = params.modelId;
  if (modelId === undefined) {
    throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
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
    modelId: modelId.trim(),
    hasExplicitProviderConnectionId,
    explicitProviderConnectionId,
  });
  if (!request) {
    return { ok: false, code: 'unsupported' };
  }
  if (params.callerInputConstraints && !isModelRefGrantedV1(params.callerInputConstraints, request.selection)) {
    return { ok: false, code: 'model_not_granted', sessionId: sessionTarget.sessionId };
  }

  return await runModelIntentAtAuthoritativeDisposition({
    observedActive: sessionTarget.rawSession.active === true,
    invokeObservedActiveOwner: async () =>
      await invokeActiveModelTransition({
        credentials: params.credentials,
        sessionTarget,
        selection: request.selection,
        callerInputConstraints: params.callerInputConstraints,
        externalAction: params.externalAction,
      }),
    updateInactiveIntent: async () => {
      const candidate = createModelIntentMetadataCasCandidate({
        selection: request.selection,
      });
      const result = await updateSessionMetadataWithRetry({
        token: params.credentials.token,
        ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
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
        ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
        ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
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
        modelId: modelId.trim(),
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
        callerInputConstraints: params.callerInputConstraints,
        externalAction: params.externalAction,
      });
    },
  });
}
