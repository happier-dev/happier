import type { SessionAwarenessProjectionV1, SessionStatusResult } from '@happier-dev/protocol';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { listPendingRequests, readSharedMetadataActionConfirmationState } from '@happier-dev/session-core/pending';
import { projectCliSessionAwarenessV1 } from '@/cli/output/session/sessionAwareness';
import type { StoredCredentials } from '@/persistence';
import { summarizeSessionRecord, type SessionSummary } from '@/cli/output/session/sessionSummary';
import { decryptSessionPayload, readSessionPresentationContent, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { ConnectedServiceBindingsV2IngressSchema, projectConnectedServiceBindingsForChild } from '@happier-dev/protocol/connect/connected-service-bindings';
import {
  readLatestAgentStateSummaryViaSocket,
  summarizeAgentState,
  type AgentStateSummary,
} from '@/session/transport/socket/sessionSocketAgentState';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readSessionReadiness, type SessionReadinessInventoryReader, type SessionReadinessCredentialReader } from './readSessionReadiness';
import type { SessionReadinessV1 } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import type { QualifiedConnectedAccountPurposeTeamResourceSelectionV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { ensureSessionDisplayProjectionAfterOwnerRead } from '@/session/metadata/updateSessionMetadataWithRetry';
import type { SessionAcceptedWorkspaceV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveAgentExecutionTargetFromSessionMetadata } from '@happier-dev/agents/runtime/identity/resolveAgentIdFromSessionMetadata';

export type GetSessionStatusResult =
  | Readonly<{ ok: true; session: SessionSummary; agentState: AgentStateSummary | null; awareness: SessionAwarenessProjectionV1; readiness?: SessionReadinessV1;
      connectedServices?: SessionStatusResult['connectedServices'];
      acceptedWorkspace?: SessionAcceptedWorkspaceV1;
      agentTarget?: SessionStatusResult['agentTarget'];
      pendingRequests: SessionStatusResult['pendingRequests'] }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'unsupported' | 'encryption_material_unavailable'; candidates?: string[] }>;

function readSessionAgentState(params: Readonly<{
  sessionTarget: Extract<Awaited<ReturnType<typeof resolveSessionTransportContext>>, { ok: true }>;
}>): unknown | null {
  const agentStateCiphertext =
    typeof params.sessionTarget.rawSession.agentState === 'string'
      ? String(params.sessionTarget.rawSession.agentState).trim()
      : '';
  if (!agentStateCiphertext) {
    return null;
  }

  try {
    const decrypted =
      params.sessionTarget.mode === 'plain'
        ? JSON.parse(agentStateCiphertext)
        : decryptSessionPayload({
            ctx: params.sessionTarget.ctx,
            ciphertextBase64: agentStateCiphertext,
          });
    return decrypted;
  } catch {
    return null;
  }
}

function resolveLiveStatusWaitMs(): number {
  const liveWaitRaw = String(process.env.HAPPIER_SESSION_STATUS_LIVE_WAIT_MS ?? '').trim();
  const liveWaitParsed = liveWaitRaw ? Number.parseInt(liveWaitRaw, 10) : NaN;
  return Number.isFinite(liveWaitParsed) && liveWaitParsed > 0 ? Math.min(30_000, liveWaitParsed) : 3_000;
}

export async function getSessionStatus(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  live: boolean;
  readiness?: boolean;
  includeAcceptedWorkspace?: boolean;
  readAcceptedWorkspace?: (metadata: unknown) => Promise<SessionAcceptedWorkspaceV1 | undefined>;
  operation?: 'conversation' | 'credential';
  credentialPurpose?: QualifiedConnectedAccountPurposeV1;
  credentialTeamSelection?: QualifiedConnectedAccountPurposeTeamResourceSelectionV1;
  readReadinessInventory?: SessionReadinessInventoryReader;
  readReadinessCredential?: SessionReadinessCredentialReader;
  serverHttpBaseUrl?: string;
  signal?: AbortSignal;
  authorization?: ExternalActionExecutionAuthorizationV1;
  resolveAuthorizationHeaders?: Parameters<typeof resolveSessionTransportContext>[0]['resolveAuthorizationHeaders'];
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>): Promise<GetSessionStatusResult> {
  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    ...(params.signal ? { signal: params.signal } : {}),
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

  // Signed/custom/runtime readers cannot borrow the host Account's write
  // authority. Direct owner status reads reuse their captured full tuple.
  if (!params.authorization && !params.resolveAuthorizationHeaders) {
    await ensureSessionDisplayProjectionAfterOwnerRead({
      credentials: params.credentials, sessionId: sessionTarget.sessionId,
      accountEncryptionCurrentness: sessionTarget.accountEncryptionCurrentness,
      rawSession: sessionTarget.rawSession,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  }

  const snapshotAgentState = readSessionAgentState({ sessionTarget });
  // Explicit: the socket callback below supplies a still-unvalidated `unknown` value, and the
  // awareness normalizer is the owner that parses it. Inferring this from the snapshot branch
  // would narrow `value` to the decoded snapshot's shape and reject the live evidence.
  let agentStateEvidence: Readonly<{ value: unknown; observedAtMs: number }> | undefined =
    snapshotAgentState === null ? undefined : {
      value: snapshotAgentState,
      observedAtMs: sessionTarget.rawSession.pendingRequestObservedAt ?? sessionTarget.rawSession.updatedAt,
    };
  let agentStateSummary = snapshotAgentState === null ? null : summarizeAgentState(snapshotAgentState);

  // External Actions retain their admitted HTTP projection. The ordinary live
  // socket uses the host token and cannot stand in for requester authority.
  if (params.live && !params.authorization) {
    try {
      const liveSummary = await readLatestAgentStateSummaryViaSocket({
        token: params.credentials.token,
        sessionId: sessionTarget.sessionId,
        ctx: sessionTarget.ctx,
        sessionEncryptionMode: sessionTarget.mode,
        timeoutMs: resolveLiveStatusWaitMs(),
        onAgentStateObserved: (value, observedAtMs) => {
          agentStateEvidence = { value, observedAtMs };
        },
      });
      if (liveSummary) {
        agentStateSummary = liveSummary;
      }
    } catch {
      // Best-effort only; fall back to snapshot state.
    }
  }

  const openedAgentState = AgentStateSchema.safeParse(agentStateEvidence?.value);
  const presentation = readSessionPresentationContent({
    credentials: params.credentials,
    accountEncryptionMode: sessionTarget.accountEncryptionCurrentness.mode,
    recipientEnvelopeReadiness: sessionTarget.accountEncryptionCurrentness.recipientEnvelopeReadiness,
    rawSession: sessionTarget.rawSession,
  });
  const pendingRequests = openedAgentState.success ? listPendingRequests({
    sessionId: sessionTarget.sessionId,
    active: sessionTarget.rawSession.active,
    agentState: openedAgentState.data,
    actionConfirmations: readSharedMetadataActionConfirmationState(presentation.metadata, sessionTarget.rawSession.metadataLayoutVersion),
    presentationCompletedRequests: null,
    projected: null,
  }).map(request => ({
    requestId: request.id,
    ...(request.turnId ? { turnId: request.turnId } : {}),
    kind: request.kind,
    tool: request.tool,
  })) : null;

  const ownerMetadata = tryDecryptSessionOwnerMetadataView({ credentials: params.credentials,
    accountEncryptionMode: sessionTarget.accountEncryptionCurrentness.mode, rawSession: sessionTarget.rawSession });
  const connectedServices = ConnectedServiceBindingsV2IngressSchema.safeParse(ownerMetadata?.connectedServices);
  const agentTarget = resolveAgentExecutionTargetFromSessionMetadata(ownerMetadata);
  // A readable shared Session does not admit the viewing Account's private checkout census.
  const explicitAccess = sessionTarget.rawSession.effectiveAccess !== undefined || sessionTarget.rawSession.share !== undefined;
  const acceptedWorkspace = params.includeAcceptedWorkspace === true && ownerMetadata && explicitAccess
    && readSessionAccessProjectionRoleV1(sessionTarget.rawSession) === 'owner'
    ? await params.readAcceptedWorkspace?.(ownerMetadata) : undefined;
  params.signal?.throwIfAborted();

  return {
    ok: true,
    ...(agentTarget ? { agentTarget } : {}),
    ...(acceptedWorkspace ? { acceptedWorkspace } : {}),
    ...(connectedServices.success ? { connectedServices: projectConnectedServiceBindingsForChild(connectedServices.data) } : {}),
    session: summarizeSessionRecord({
      credentials: params.credentials,
      accountEncryptionMode: sessionTarget.accountEncryptionCurrentness.mode,
      session: sessionTarget.rawSession,
    }),
    agentState: agentStateSummary,
    pendingRequests,
    awareness: projectCliSessionAwarenessV1({
      credentials: params.credentials,
      accountEncryption: sessionTarget.accountEncryptionCurrentness,
      row: sessionTarget.rawSession,
      nowMs: Date.now(),
      ...(agentStateEvidence ? { agentState: agentStateEvidence } : {}),
    }),
    ...(params.readiness === true ? { readiness: await readSessionReadiness({
      credentials: params.credentials, target: sessionTarget,
      ...(params.operation ? { operation: params.operation } : {}), ...(params.credentialPurpose ? { credentialPurpose: params.credentialPurpose } : {}),
      ...(params.credentialTeamSelection ? { credentialTeamSelection: params.credentialTeamSelection } : {}),
      ...(params.readReadinessInventory ? { readInventory: params.readReadinessInventory } : {}),
      ...(params.readReadinessCredential ? { readCredential: params.readReadinessCredential } : {}),
      ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.authorization ? { authorization: params.authorization } : {}),
    }) } : {}),
  };
}
