import axios from '@/api/client/credentialAxios';
import { randomUUID } from 'node:crypto';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { evaluateSessionFollowRuleOccurrenceV1, type SessionFollowRuleSourceOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import { resolveFollowDeliveryV1, resolveSessionFollowSelectedDeliveryV1, isFollowPolicyEqualV1, type FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { type SessionFollowSessionPendingObservationV1, type SessionFollowRunRouteReleaseReasonV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { DiscussionMessageRefV1Schema } from '@happier-dev/protocol/discussions/messageRefs';
import { SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1, ListSessionFollowSourcesResponseSchema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import type { RunFollowOriginalV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { deriveSessionFollowInputLocalIdV1, RunFollowOccurrenceV1Schema, resolveSessionFollowTurnEventV1, type SessionFollowInputV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { SessionFollowRunOccurrence } from '@/daemon/sessions/sessionActivityChangedContract';
import { isFollowDeliveryMutedV1, followDeliveryMuteScopeKeyV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1, type OtherAccountFollowV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import type { SessionQuestionHandlerV1 } from '@happier-dev/protocol/sessions/permissions/questionV1';
import { buildTrustedHostSessionInputAdmissionV1, SessionInputRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionFollowRelationWitnessesV1Schema, type SessionFollowRelationWitnessV1, type SessionFollowSourceOccurrenceWitnessV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';
import { SessionFollowSourceTurnV1Schema, SessionFollowStalledOccurrenceV1Schema, isSessionFollowStalledOccurrenceCurrentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readSessionDeliveryMutedScopes } from '@/api/sessionDeliveryMuteTransport';
import { readCliSessionListFilterFactsV1 } from '@/cli/output/session/sessionListFilterFacts';
import type { StoredCredentials } from '@/persistence';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { resolveSessionMessageAdmissionTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import type { PersonalFollowOccurrenceDispatch, PersonalFollowOccurrenceDispatchResult } from '@/notifications/activity/dispatchPersonalFollowOccurrence';
import type { SessionActivityChangedResult } from '@/daemon/sessions/sessionActivityChangedContract';
import { createAccountSessionFollowRuleCache, type SessionFollowReceiverSourceRanges } from './accountSessionFollowRuleCache';
import { logger } from '@/ui/logger';
import { SESSION_FOLLOW_INFORMATION_NOTICE } from './sessionFollowNotice';
import { normalizeSessionFollowTerminalSourceOccurrence, readSessionFollowOriginalRoutes, readCommittedSessionFollowSourceOccurrence, type SessionFollowAccountOccurrence } from './sessionFollowRuleSourceEvidence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { createSessionFollowSourceKeyPreparationAfterSet } from './createSessionFollowSourceKeyPreparationAfterSet';
import { submitAccountFollowPersonalProgress } from '@/api/sessionFollowPersonalProgressTransport';
import { openSessionStateValue } from '@happier-dev/sync-client';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { decryptSessionPayload, encryptSessionPayload, resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchInactiveSessionFollowObservations } from '@/session/transport/http/sessionFollowInactiveObservationsHttp';
import { resolveSessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { isSessionFollowFrontierEqualV1, isSessionFollowTurnEqualV1, SESSION_FOLLOW_ZERO_FRONTIER_V1, projectSessionFollowFrontierFromSourceV1, type SessionFollowFrontierV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { createAccountRunFollowRoutes, type RunFollowRouteRead } from './accountRunFollowRoutes';

type TerminalSourceMessage = Extract<SessionFollowAccountOccurrence, { sourceMessage: unknown }>['sourceMessage'];
type AdmittedSourceTransport = Extract<Awaited<ReturnType<typeof resolveSessionTransportContext>>, { ok: true }>;
import { requestInactiveSessionResume } from '@/session/services/requestInactiveSessionResume';
import { createSessionFollowSourceHydrator } from './sessionFollowSourceHydrator';
import { shouldWakeForSessionFollowWorkerUpdate } from './sessionFollowContextReconciler';
import { readActiveForegroundAgentRequests, readForegroundAgentRequestFollowEvent } from '@/agent/permissions/activeForegroundRequests';
import { captureSemanticSessionFollowRuleSourceEvidence } from './sessionFollowRuleSourceEvidence';
import type { ListSessionFollowRulesResponseV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { ListAccountSessionFollowsResponseV1Schema } from '@happier-dev/protocol/sessions/follow/api';
import { resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { matchSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { SessionFollowRuleInvalidation } from './sessionFollowRuleCache';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { createSessionFollowSourceFactsRead } from './sessionFollowSourceFacts';
export type { SessionFollowAccountOccurrence } from './sessionFollowRuleSourceEvidence';
export type SessionFollowReceiverRangeResult = Readonly<{ receiverSessionIds: readonly string[] }>;
export type { SessionFollowRunOccurrence } from '@/daemon/sessions/sessionActivityChangedContract';
type AccountFollowSourceRange = Readonly<{ sourceSessionId?: string; source?: RunFollowOriginalV1['source'];
  workflowRunIds?: readonly string[]; discussionIds?: readonly string[]; configurationChanged?: boolean; outputsOnly?: boolean }>;
export type SessionFollowOccurrenceDispatch = Readonly<
  { occurrence: SessionFollowRuleSourceOccurrenceV1 | SessionFollowRunOccurrence; destinationSessionId?: never; contextSessionId?: string }
  | { occurrence: SessionFollowAccountOccurrence; destinationSessionId: string }
  | { observations: readonly SessionFollowSessionPendingObservationV1[]; destinationSessionId: string; sourceSessionId?: string; occurrence?: never }
  | { sourceSessionIdChanged: string; followSourceChanged?: false; followReceiverAvailabilityChanged?: boolean;
    contextSessionId?: string; occurrence?: never; destinationSessionId?: never }
  | { accountFollowSourcesChanged: AccountFollowSourceRange; occurrence?: never; destinationSessionId?: never }
  | { executionRunSourceChanged: Extract<RunFollowOriginalV1['source'], { kind: 'execution_run' }>; includeRun?: boolean;
    occurrence?: never; destinationSessionId?: never; contextSessionId?: string }
>;

/** One captured Account daemon: original read, current predicate, route union, existing Pending admission. */
export function createSessionFollowOccurrenceDispatcher(input: Readonly<{
  accountId: string; credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string;
  machineId: string; installationId: string; signal: AbortSignal;
  isCurrent: () => Promise<boolean>;
  subscribeInvalidation: (listener: (change?: SessionFollowRuleInvalidation) => void) => () => void;
  /** Borrowed from the already-retained requester Account lifetime, never an installed Account substitute. */
  rulesCache?: ReturnType<typeof createAccountSessionFollowRuleCache>;
  runRoutes?: ReturnType<typeof createAccountRunFollowRoutes>;
  spawnSession?: Parameters<typeof sendSessionMessage>[0]['spawnSession'];
  isSessionAlreadyRunning?: (sessionId: string) => Promise<boolean>;
  resolveServerFeaturesSnapshot?: () => Promise<Parameters<typeof sendSessionMessage>[0]['serverFeaturesSnapshot']>;
  resolveSourceKeyContext: () => Promise<ActionExecutorContext | null>;
  /** Personal effects require their own saved-settings scope, not Session delivery's Account observation. */
  isPersonalCurrent: () => boolean | Promise<boolean>;
  dispatchPersonal: (dispatch: PersonalFollowOccurrenceDispatch, isCurrent: () => Promise<boolean>) => Promise<PersonalFollowOccurrenceDispatchResult | void>;
}>) {
  const rules = input.rulesCache ?? createAccountSessionFollowRuleCache({ ...input,
    isCurrent: input.isCurrent,
  });
  const current = async () => !input.signal.aborted && await input.isCurrent();
  const runRoutes = input.runRoutes ?? createAccountRunFollowRoutes({ ...input, isCurrent: current });
  // Reconnect/configuration owns Account discovery. Session arrivals select
  // from that same compact projection; final route admission stays fresh.
  type AccountSourceInterest = Readonly<{ source: OtherAccountFollowV1['source'];
    policy?: FollowPolicyV1; once: OtherAccountFollowV1['once'] }>;
  let accountSourceInterests = new Map<string, AccountSourceInterest>();
  let accountSessionRunInterests = new Map<string, readonly AccountSourceInterest[]>();
  let accountSourceProjectionRead: Promise<Map<string, AccountSourceInterest> | null> | null = null;
  // Only routing identities and fixed decision categories cross this diagnostic boundary.
  const checkpoint = (facts: Readonly<{ entry: 'source' | 'receiver' | 'receiver_range'; sourceSessionId?: string;
    destinationSessionId?: string; sourceMessageSeq?: number; agentStateVersion?: number }>,
    phase: string, status: 'started' | 'completed' | 'held', details: Readonly<{
      reason?: string; httpStatus?: number; candidateCount?: number; afterSeq?: number; throughSeq?: number;
      sourceSessionId?: string; sourceMessageSeq?: number;
    }> = {}) => logger.debug('[Session Follow] Dispatch checkpoint', { ...facts, phase, status, ...details });
  const prepareSourceKey = createSessionFollowSourceKeyPreparationAfterSet({ credentials: input.credentials,
    serverHttpBaseUrl: input.serverHttpBaseUrl, resolveServerFeaturesSnapshot: input.resolveServerFeaturesSnapshot });
  // Waiting and stall have no terminal original input.
  // They share source traversal/admission with originals, then retain their
  // existing host context-only acceptance and frontier ACK.
  const dispatchNoOriginalTurn = async (observation: SessionFollowSessionPendingObservationV1) => {
    const sessionId = observation.destinationSessionId;
    const turn = observation.observed.turn;
    if (!turn || !(turn.status === 'stalled' || observation.relation === 'manager' && turn.status === 'waiting')
      || isSessionFollowFrontierEqualV1(observation.delivered, observation.observed)
      || !input.spawnSession || !input.isSessionAlreadyRunning) return;
    if (turn.status === 'stalled' && (observation.relation === 'rule'
      ? observation.effectiveDelivery !== 'wake'
      : !resolveFollowDeliveryV1({ policies: [observation.policy], event: { kind: 'stalled' } }).session.wake)) return;
    if (!await current() || await input.isSessionAlreadyRunning(sessionId)) return;
    const readReceiver = async () => {
      const receiver = await resolveSessionTransportContext({ reason: 'follow-occurrence', credentials: input.credentials, idOrPrefix: sessionId, signal: input.signal });
      if (!receiver.ok || receiver.sessionId !== sessionId || !await current()) return null;
      const metadata = tryDecryptSessionOwnerMetadataView({ credentials: input.credentials, rawSession: receiver.rawSession,
        accountEncryptionMode: receiver.accountEncryptionCurrentness.mode });
      return metadata && resolveSessionAutoResumeAdmissionV1({ metadata, archivedAt: receiver.rawSession.archivedAt,
        machineAvailable: true, authorityAvailable: true }) === 'eligible' ? { ...receiver, metadata } : null;
    };
    if (!await readReceiver()) return;
    const hydrate = createSessionFollowSourceHydrator({ credentials: input.credentials, session: {
      sessionId,
      runSessionFollowSourceRequest: ({ credentials, request }) => {
        if (credentials.token !== input.credentials.token) throw new Error('Follow credentials do not belong to the observed Home');
        return runWithServerHttpBaseUrl(input.serverHttpBaseUrl, request);
      },
    } });
    const source = await hydrate({ observation, signal: input.signal });
    if (!source || !shouldWakeForSessionFollowWorkerUpdate(observation, source)
      || source.recheckWorkerUpdateAdmission && !await source.recheckWorkerUpdateAdmission(input.signal)) return;
    const receiver = await readReceiver();
    const origin = await input.resolveSourceKeyContext();
    if (!receiver || !origin || !await current()) return;
    const observed = await fetchInactiveSessionFollowObservations({ token: input.credentials.token,
      destinationSessionId: sessionId, machineId: input.machineId, installationId: input.installationId,
      reason: 'manager-turn-admission', signal: input.signal });
    if (!observed?.ok || observed.target.homeId !== origin.serverIdentityId || observed.target.accountId !== input.accountId
      || observed.target.sessionId !== sessionId || observed.target.machineId !== input.machineId
      || observed.target.installationId !== input.installationId || !await current()) return;
    const pending = observed.observations.find(candidate => 'sourceSessionId' in candidate && !('kind' in candidate)
      && candidate.sourceSessionId === observation.sourceSessionId && candidate.relation === observation.relation
      && candidate.attachedAt === observation.attachedAt
      && (observation.relation === 'rule' ? candidate.relation === 'rule'
        && candidate.effectiveDelivery === observation.effectiveDelivery && sameStrictJsonValue(candidate.presence, observation.presence)
        : candidate.relation !== 'rule' && isFollowPolicyEqualV1(candidate.policy, observation.policy))
      && isSessionFollowFrontierEqualV1(candidate.delivered, observation.delivered)
      && isSessionFollowFrontierEqualV1(candidate.observed, observation.observed));
    if (!pending || !await current() || await input.isSessionAlreadyRunning(sessionId)) return;
    await requestInactiveSessionResume({ credentials: input.credentials, sessionId, rawSession: receiver.rawSession,
      metadata: receiver.metadata, requestId: randomUUID(), executionAuthority: 'account_automation',
      spawnSession: input.spawnSession, signal: input.signal });
    return true;
  };
  const dispatchRun = async (request: RunFollowRouteRead, receiverSessionId?: string, personalOnly = false,
    releaseReason?: SessionFollowRunRouteReleaseReasonV1): Promise<void> => {
    if (!await current()) return;
    const routes = await runRoutes.read({ v: 1, ...('original' in request ? { original: request.original } : { source: request.source,
      ...(request.outputRef ? { outputRef: request.outputRef } : {}) }) }, { ...(receiverSessionId ? { receiverSessionId } : {}), personalOnly }, releaseReason);
    if (!routes || 'original' in request && !sameStrictJsonValue(routes.original, request.original)
      || !await current()) return;
    const occurrence = RunFollowOccurrenceV1Schema.parse({ original: routes.original, event: routes.event });
    if (!receiverSessionId && routes.personal && !routes.personal.alreadyRepresented && await input.isPersonalCurrent() && await current()) {
      const policies = [routes.personal.policy];
      await input.dispatchPersonal({ occurrence, policies, signal: input.signal, acceptDelivery: async () => {
        if (!await current() || !await input.isPersonalCurrent()) return false;
        const accepted = await submitAccountFollowPersonalProgress({ token: input.credentials.token,
          serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal, occurrence: { original: occurrence.original } });
        return accepted?.accepted === true && !accepted.alreadyRepresented;
      } }, async () => {
        if (!await current() || !await input.isPersonalCurrent()) return false;
        const latest = await runRoutes.read({ v: 1, original: occurrence.original }, { personalOnly: true });
        return Boolean(latest?.personal && isFollowPolicyEqualV1(latest.personal.policy, policies[0]!)
          && sameStrictJsonValue(latest.original, occurrence.original));
      });
    }
    if (personalOnly || 'output' in occurrence.original) return;
    for (const route of routes.routes) {
      if (receiverSessionId !== undefined && route.destinationSessionId !== receiverSessionId) continue;
      const selected = resolveFollowDeliveryV1({ policies: [route.policy], event: occurrence.event });
      if (!selected.selected || !await current()) continue;
      const source = occurrence.original.source;
      const muted = await readSessionDeliveryMutedScopes({ token: input.credentials.token,
        receiver: { kind: 'session', sessionId: route.destinationSessionId }, serverHttpBaseUrl: input.serverHttpBaseUrl,
        signal: input.signal });
      // Confirmed mute must reach Pending's discarded-original settlement.
      // Unknown policy still holds until its existing availability release.
      if (!muted) continue;
      const delivery = { v: 1 as const, original: occurrence.original, event: occurrence.event,
        delivery: selected.session.wake ? 'wake' as const : 'next_turn' as const };
      const relation = { relation: route.relation, attachedAt: route.attachedAt, source,
        ...('expectedRevision' in route ? { expectedRevision: route.expectedRevision }
          : { expectedTerminalEventId: route.expectedTerminalEventId }) };
      const admission = buildTrustedHostSessionInputAdmissionV1('agent');
      const features = await input.resolveServerFeaturesSnapshot?.();
      await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => sendSessionMessage({ credentials: input.credentials,
        idOrPrefix: route.destinationSessionId, wait: false,
        localId: deriveSessionFollowInputLocalIdV1({ destinationSessionId: route.destinationSessionId, original: delivery.original }),
        timeoutMs: resolveSessionMessageAdmissionTimeoutMs(), message: `Followed Run ${occurrence.event.kind}: ${JSON.stringify(source)}. ${SESSION_FOLLOW_INFORMATION_NOTICE}`,
        inputAdmission: { provenance: admission.provenance,
          request: SessionInputRequestV1Schema.parse({ ...admission.request, followDeliveryV1: delivery }) },
        followRelations: SessionFollowRelationWitnessesV1Schema.parse([relation]), informationDelivery: 'session_follow', executionAuthority: 'account_automation',
        resumeInactiveSession: selected.session.wake, ...(input.spawnSession ? { spawnSession: input.spawnSession } : {}),
        ...(features ? { serverFeaturesSnapshot: features } : {}), signal: input.signal }));
    }
  };
  runRoutes.bindDispatch((request, context) => dispatchRun(request, context.receiverSessionId, context.personalOnly));
  const dispatchDiscussion = async (source: Readonly<{ kind: 'discussion'; discussionId: string }>) => {
    const read = async (messageId?: string) => {
      if (!await current() || !await input.isPersonalCurrent()) return null;
      const occurrence = await runRoutes.readDiscussion({ v: 1, source, ...(messageId ? { messageId } : {}) });
      return occurrence && await current() ? occurrence : null;
    };
    for (;;) {
      const occurrence = await read();
      if (!occurrence || occurrence.personal.alreadyRepresented) return;
      const original = DiscussionMessageRefV1Schema.parse({ kind: 'discussion',
        discussion: { serverId: input.serverId, discussionId: source.discussionId }, messageId: occurrence.messageId });
      let settled = false;
      await input.dispatchPersonal({ occurrence: { discussion: { original, seq: occurrence.seq, event: occurrence.event } },
        policies: [occurrence.personal.policy], signal: input.signal, acceptDelivery: async () => {
          if (!await current() || !await input.isPersonalCurrent()) return false;
          const acceptance = await submitAccountFollowPersonalProgress({ token: input.credentials.token,
            serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal, occurrence: { discussion: { original, seq: occurrence.seq } } });
          settled = acceptance?.accepted === true;
          return settled && acceptance?.alreadyRepresented === false;
        } }, async () => {
          const latest = await read(occurrence.messageId);
          return Boolean(latest && latest.seq === occurrence.seq && sameStrictJsonValue(latest.source, source)
            && isFollowPolicyEqualV1(latest.personal.policy, occurrence.personal.policy));
        });
      // Unavailable progress custody holds this exact original. A read
      // never consumes it or spins while the same effect remains unrepresented.
      if (!settled) return;
    }
  };
  runRoutes.bindDiscussionDispatch(dispatchDiscussion);
  const readAccountSourceInterests = async (source?: RunFollowOriginalV1['source']) => {
    let cursor: string | undefined;
    const relations: OtherAccountFollowV1[] = [];
    do {
      if (!await current() || !await input.isPersonalCurrent()) return null;
      const request = resolveSessionFollowActionRequest('follow.list', { direction: 'following', receiver: { kind: 'account' },
        ...(source ? { source } : { sourceKinds: ['execution_run', 'workflow_run', 'discussion'] }),
        ...(cursor ? { cursor } : {}) });
      const response = await axios.get(`${input.serverHttpBaseUrl}${request.path}`, {
        headers: { Authorization: `Bearer ${input.credentials.token}` },
        signal: input.signal, validateStatus: () => true,
      });
      const page = response.status === 200 ? ListAccountSessionFollowsResponseV1Schema.safeParse(response.data) : null;
      if (!page?.success || !await current()) return null;
      relations.push(...page.data.follows.filter((relation): relation is OtherAccountFollowV1 => 'source' in relation));
      cursor = page.data.continuation;
    } while (cursor && await current());
    const nextInterests = new Map<string, AccountSourceInterest>();
    for (const relation of relations) {
      if (!relation.following && !relation.once?.length) continue;
      const interest: AccountSourceInterest = { source: relation.source,
        ...(relation.following && relation.persistent ? { policy: relation.policy } : {}), once: relation.once ?? null };
      nextInterests.set(followDeliveryMuteScopeKeyV1({ kind: 'source', source: relation.source }), interest);
    }
    return nextInterests;
  };
  const refreshAccountSourceInterests = () => {
    // Until this observation succeeds, unchanged-intent suppression cannot
    // prove that intervening source arrivals were covered.
    accountSourceInterests = new Map();
    accountSessionRunInterests = new Map();
    const work = readAccountSourceInterests().then(nextInterests => {
      // A real configuration/reconnect refresh supersedes an unfinished load.
      if (!nextInterests || accountSourceProjectionRead !== work) return null;
      const nextSessionRuns = new Map<string, AccountSourceInterest[]>();
      for (const interest of nextInterests.values()) if (interest.source.kind === 'execution_run' && 'sessionId' in interest.source) {
        const runs = nextSessionRuns.get(interest.source.sessionId) ?? [];
        runs.push(interest);
        nextSessionRuns.set(interest.source.sessionId, runs);
      }
      accountSourceInterests = nextInterests;
      accountSessionRunInterests = nextSessionRuns;
      return nextInterests;
    });
    accountSourceProjectionRead = work;
    return work;
  };
  const dispatchAccountSourceRange = async (filter: AccountFollowSourceRange = {}) => {
    // The retained-source owner proves the personal relation itself. Exact
    // source hints need no Account-wide discovery; reconnects still page it.
    if (!await current() || !await input.isPersonalCurrent()) return;
    if (filter.source?.kind === 'execution_run' && !filter.outputsOnly) await runRoutes.available(filter.source, 'exact_run');
    else if (Object.keys(filter).length === 0) await runRoutes.available({ kind: 'reconnected' }, 'full_recovery');
    if (filter.sourceSessionId === undefined && (filter.workflowRunIds || filter.discussionIds)) {
      for (const runId of new Set(filter.workflowRunIds)) {
        if (!await current() || !await input.isPersonalCurrent()) return;
        await dispatchRun({ source: { kind: 'workflow_run', runId } }, undefined, true);
      }
      for (const discussionId of new Set(filter.discussionIds)) {
        if (!await current() || !await input.isPersonalCurrent()) return;
        await runRoutes.available({ kind: 'discussion', discussionId });
        await dispatchDiscussion({ kind: 'discussion', discussionId });
      }
      return;
    }
    const priorInterests = accountSourceInterests;
    // A recreated lifetime may receive a Session hint before reconnect. Share
    // its first observation; a failed load waits for a real refresh, never a
    // stream of unrelated Session hints. These are discovery facts, not grants.
    const nextInterests = await (filter.sourceSessionId !== undefined
      ? accountSourceProjectionRead ?? refreshAccountSourceInterests()
      : filter.source ? readAccountSourceInterests(filter.source) : refreshAccountSourceInterests());
    if (!nextInterests || !await current() || !await input.isPersonalCurrent()) return;
    const interests = filter.sourceSessionId === undefined ? nextInterests.values()
      : accountSessionRunInterests.get(filter.sourceSessionId) ?? [];
    for (const relation of interests) {
        const source = relation.source;
        const key = followDeliveryMuteScopeKeyV1({ kind: 'source', source });
        if (filter.configurationChanged && sameStrictJsonValue(priorInterests.get(key) ?? null, relation)) continue;
        if (filter.source && !sameStrictJsonValue(source, filter.source)) continue;
        if (source.kind !== 'execution_run' && source.kind !== 'workflow_run' && source.kind !== 'discussion') continue;
        if (filter.sourceSessionId && (source.kind !== 'execution_run' || !('sessionId' in source) || source.sessionId !== filter.sourceSessionId)) continue;
        if ((filter.workflowRunIds || filter.discussionIds) && !(source.kind === 'workflow_run' && filter.workflowRunIds?.includes(source.runId)
          || source.kind === 'discussion' && filter.discussionIds?.includes(source.discussionId))) continue;
        if (source.kind === 'discussion') await dispatchDiscussion(source);
        else {
          if (!filter.outputsOnly && (relation.policy || relation.once?.some(once => once.kind !== 'output_ready')))
            await dispatchRun({ source }, undefined, true);
          for (const once of relation.once ?? []) if (once.kind === 'output_ready')
            await dispatchRun({ source, outputRef: once.outputRef }, undefined, true);
        }
    }
  };
  const readRoutes = async (occurrence: SessionFollowRuleSourceOccurrenceV1 | SessionFollowAccountOccurrence, destinationSessionId?: string) => {
    return readSessionFollowOriginalRoutes({ ...input, occurrence, destinationSessionId, isCurrent: current });
  };
  const dispatch = async (occurrence: SessionFollowRuleSourceOccurrenceV1 | SessionFollowAccountOccurrence, receiverSessionId?: string,
    fromSourceRange = false,
    nativePersonalOriginal?: Extract<SessionFollowAccountOccurrence, { sourceMessage: unknown }>,
    terminalSourceMessage?: TerminalSourceMessage,
    sourceTransport?: AdmittedSourceTransport,
    readSourceFacts?: ReturnType<typeof createSessionFollowSourceFactsRead>, originalRevision?: number): Promise<SessionActivityChangedResult | void> => {
      if ('sourceMessage' in occurrence && (occurrence.evidence.event.kind === 'finished' || occurrence.evidence.event.kind === 'failed_or_stopped')) {
        const normalized = await normalizeSessionFollowTerminalSourceOccurrence({ ...input, occurrence, isCurrent: current });
        if (!normalized) return;
        return dispatch(normalized, receiverSessionId, fromSourceRange,
          normalized.evidence.event.kind === occurrence.evidence.event.kind ? occurrence : undefined, occurrence.sourceMessage,
          sourceTransport, readSourceFacts, originalRevision);
      }
      let finishWork: ((outcome: 'held' | 'settled' | 'admitted', waitingFor?: 'source' | 'receiver') => void) | null = null;
      let workOutcome: 'held' | 'settled' | 'admitted' = 'held';
      let workWaitingFor: 'source' | 'receiver' = 'source';
      let admittedWork = false;
      if (receiverSessionId && ('sourceMessage' in occurrence || 'sourceTurn' in occurrence)) {
        if (!await current()) return;
        const original = 'sourceMessage' in occurrence
          ? { sourceSessionId: occurrence.sourceSessionId, sourceMessage: occurrence.sourceMessage }
          : { sourceSessionId: occurrence.sourceSessionId, sourceTurn: occurrence.sourceTurn };
        if (!fromSourceRange) {
          const state = rules.originalWork.state(receiverSessionId, original);
          if (state) return state === 'settled' || state === 'admitted' ? {} : undefined;
        } else {
          finishWork = rules.originalWork.start(receiverSessionId, original, originalRevision);
          if (!finishWork) {
            const state = rules.originalWork.state(receiverSessionId, original);
            return state === 'settled' || state === 'admitted' ? {} : undefined;
          }
        }
      }
      try {
      let personalFollow: SessionActivityChangedResult['personalFollow'];
      const diagnostic = { entry: receiverSessionId ? 'receiver' as const : 'source' as const,
        sourceSessionId: occurrence.sourceSessionId, ...(receiverSessionId ? { destinationSessionId: receiverSessionId } : {}),
        ...('sourceMessage' in occurrence ? { sourceMessageSeq: occurrence.sourceMessage.seq }
          : 'sourceRequests' in occurrence ? { agentStateVersion: occurrence.sourceRequests.agentStateVersion } : {}) };
      checkpoint(diagnostic, 'currentness', 'started');
      if (!await current()) { checkpoint(diagnostic, 'currentness', 'held', { reason: 'account_not_current' }); return; }
      if (!receiverSessionId && (!('sourcePublisher' in occurrence) || occurrence.sourcePublisher.machineId !== input.machineId)) {
        checkpoint(diagnostic, 'currentness', 'held', { reason: 'source_publisher_mismatch' }); return;
      }
      const prepareSource = async () => {
        checkpoint(diagnostic, 'source', 'started');
        // Ordered range traversal already admitted this resource in this pass.
        // Keep its transport/currentness and original checks; do not acquire the
        // same Session again merely to prepare its rule facts.
        const [accountEncryption, source] = sourceTransport
          ? [sourceTransport.accountEncryptionCurrentness, sourceTransport.rawSession] as const
          : await Promise.all([
          fetchAccountEncryptionCurrentness({ token: input.credentials.token, serverBaseUrl: input.serverHttpBaseUrl, signal: input.signal }),
          fetchSessionById({ reason: 'follow-occurrence', token: input.credentials.token, sessionId: occurrence.sourceSessionId,
            serverUrl: input.serverHttpBaseUrl, signal: input.signal }),
        ]);
        if (!source || source.archivedAt !== null && source.archivedAt !== undefined || !await current()) {
          checkpoint(diagnostic, 'source', 'held', { reason: !source ? 'source_unavailable'
            : source.archivedAt != null ? 'source_archived' : 'account_not_current' }); return null;
        }
        let requestState: ReturnType<typeof AgentStateSchema.parse> | null = null;
        if ('sourceRequests' in occurrence && source.ownerAccountId === input.accountId
          && source.agentStateVersion >= occurrence.sourceRequests.agentStateVersion && typeof source.agentState === 'string') {
          const mode = resolveSessionStoredContentEncryptionMode(source);
          const ctx = mode === 'plain' ? null : resolveSessionEncryptionContextFromCredentials(input.credentials, source);
          const state = await openSessionStateValue(mode === 'plain' ? { mode: 'plain' } : {
            mode: 'e2ee', encryption: ctx ? {
              encryptRaw: async payload => encryptSessionPayload({ ctx, payload }),
              decryptRaw: async ciphertextBase64 => decryptSessionPayload({ ctx, ciphertextBase64 }),
            } : null,
          }, source.agentState);
          const parsed = state.status === 'ready' ? AgentStateSchema.safeParse(state.value) : null;
          if (parsed?.success) requestState = parsed.data;
        }
        return { accountEncryption, source, agentStateVersion: source.agentStateVersion, origin: source.origin ?? null,
          requests: requestState ? new Map(readActiveForegroundAgentRequests(requestState)) : null };
      };
      let preparedSource: Awaited<ReturnType<typeof prepareSource>> | undefined;
      const prepareRuleSource = async () => {
        checkpoint(diagnostic, 'rules', 'started');
        // Rule/default authoring changes arrive through the Account feed.
        // Originals and range arrivals do not change that configuration.
        const opened = await rules.read();
        if (opened.status !== 'available') { checkpoint(diagnostic, 'rules', 'held', { reason: opened.reason }); return null; }
        if (!await current()) { checkpoint(diagnostic, 'rules', 'held', { reason: 'account_not_current' }); return null; }
        preparedSource ??= await prepareSource();
        if (!preparedSource) return null;
        const { source, accountEncryption } = preparedSource;
        checkpoint(diagnostic, 'facts', 'started');
        const facts = readSourceFacts ? await readSourceFacts(opened.rules) : await readCliSessionListFilterFactsV1({ credentials: input.credentials, accountEncryption,
          row: source, serverId: input.serverId, nowMs: Date.now(),
          accountId: input.accountId, serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal, isCurrent: current,
          filters: opened.rules.filter(rule => rule.definition.enabled).map(rule => rule.definition.filter) });
        if (!facts) { checkpoint(diagnostic, 'facts', 'held', { reason: 'source_facts_unavailable' }); return null; }
        return { ...preparedSource, opened, facts };
      };
      // The admitted original owns preparation demand. Share the same fresh
      // facts within this request map, never across operations or refusals.
      let ruleSource: Awaited<ReturnType<typeof prepareRuleSource>> | undefined;
      if ('sourceRequests' in occurrence) {
        // IPC carries a hint, not a frozen request map. Read its exact source
        // once before asking the server to attest the current version. Ordinary
        // Agent-state bookkeeping must not strand the same live question.
        preparedSource = await prepareSource();
        if (!preparedSource) return;
        const { agentStateVersion, origin, requests } = preparedSource;
        if (agentStateVersion !== occurrence.sourceRequests.agentStateVersion) {
          if (!requests || !occurrence.sourceRequests.requests.some(original => {
            const pending = requests.get(original.requestId);
            return pending?.createdAt === original.createdAt && pending.turnId === original.turnId;
          })) return;
          // Carry the whole current map so personal progress cannot consume a
          // newer sibling that was absent from the older notification.
          const active = [...requests];
          occurrence = { ...occurrence, sourceRequests: { agentStateVersion,
            requests: active.map(([requestId, request]) => ({ requestId, createdAt: request.createdAt,
              ...(request.turnId ? { turnId: request.turnId } : {}) })) },
            requestEvidence: active.map(([requestId, request]) => {
              const event = readForegroundAgentRequestFollowEvent(request);
              const evidence = event ? captureSemanticSessionFollowRuleSourceEvidence({ serverId: input.serverId,
                ownerAccountId: input.accountId, origin, event }) : null;
              return { requestId, ...(evidence ? { evidence } : {}) };
            }) };
        }
      }
      // A request map is a currentness fence, never one aggregate semantic occurrence.
      const requestOccurrence = 'sourceRequests' in occurrence ? occurrence : null;
      const originals: (SessionFollowRuleSourceOccurrenceV1 | SessionFollowAccountOccurrence)[] = requestOccurrence
        ? requestOccurrence.sourceRequests.requests.flatMap(request => {
          const evidence = requestOccurrence.requestEvidence.find(item => item.requestId === request.requestId)?.evidence;
          return evidence?.event.kind === 'needs_you' ? [{ ...requestOccurrence,
            sourceRequests: { ...requestOccurrence.sourceRequests, requests: [request] }, requestEvidence: [{ requestId: request.requestId, evidence }] }] : [];
        }) : [occurrence];
      const personalRequestRules = new Map<string, { ruleId: string; ruleVersion: number; requestIds: Set<string> }>();
      let personalRequestPassComplete = 'sourceRequests' in occurrence && originals.length === occurrence.sourceRequests.requests.length;
      for (const original of originals) {
        const evidence = 'sourceRequests' in original ? original.requestEvidence[0]?.evidence : original.evidence;
        if (!evidence || !receiverSessionId && evidence.ownerAccountId !== input.accountId) {
          personalRequestPassComplete = false;
          continue;
        }
        const requestOriginal = 'sourceRequests' in original ? original.sourceRequests.requests[0] : undefined;
        const pending = requestOriginal ? preparedSource?.requests?.get(requestOriginal.requestId) : undefined;
        const question = pending && requestOriginal && pending.createdAt === requestOriginal.createdAt
          && pending.turnId === requestOriginal.turnId && evidence.event.kind === 'needs_you'
          && evidence.event.type !== 'approval' ? pending : null;
        const handler = question?.currentHandler;
        const routeOriginal = 'sourceRequests' in original && handler?.kind === 'session'
          ? { ...original, sourceRequests: { ...original.sourceRequests,
              requests: original.sourceRequests.requests.map(request => ({ ...request, currentHandler: handler })) } }
          : original;
        checkpoint(diagnostic, 'routes', 'started');
        const ordinary = await readRoutes(routeOriginal, receiverSessionId);
        if (ordinary === null) {
          checkpoint(diagnostic, 'routes', 'held', { reason: 'source_routes_unavailable' });
          if (receiverSessionId) return;
          personalRequestPassComplete = false;
          continue;
        } // Unsupported/denied is pending, not an empty route set.
        ruleSource ??= await prepareRuleSource();
        if (!ruleSource) return;
        const { opened, facts } = ruleSource;
        const evaluated = evaluateSessionFollowRuleOccurrenceV1({ accountId: input.accountId, evaluator: 'sourcePublisher' in original ? 'source' : 'receiver',
          production: 'sourcePublisher' in original ? 'source' : 'recovery', sourceSessionId: original.sourceSessionId, evidence, currentFacts: facts,
          rules: opened.rules.filter(rule => !rule.inception || ordinary.originalCreatedAt !== undefined
            && ordinary.originalCreatedAt >= rule.inception.createdAt),
          ...(opened.defaultPreferences && ordinary.currentAccountFacts ? { defaults: { preferences: opened.defaultPreferences,
            relationships: ordinary.currentAccountFacts.defaultRelationships,
            hasPersistentFollow: ordinary.currentAccountFacts.hasPersistentFollow } } : {}),
          ...(ordinary.currentAccountFacts ? { personalFollowSuppressed: ordinary.currentAccountFacts.personalFollowSuppressed } : {}),
        });
        if (evaluated.status !== 'evaluated') {
          checkpoint(diagnostic, 'selection', 'held', { reason: evaluated.status });
          if (receiverSessionId) return;
          personalRequestPassComplete = false;
          continue;
        }
        if (receiverSessionId && opened.rules.some(rule => evaluated.pendingRuleIds.includes(rule.ruleId)
          && rule.receiver.kind === 'session' && rule.receiver.sessionId === receiverSessionId)) return;
        const candidates = new Map<string, { policies: FollowPolicyV1[]; witnesses: SessionFollowSourceOccurrenceWitnessV1[];
          relations: SessionFollowRelationWitnessV1[]; currentHandler?: Extract<SessionQuestionHandlerV1, { kind: 'session' }> }>();
        for (const route of ordinary.routes) {
          if (receiverSessionId && route.destinationSessionId !== receiverSessionId) continue;
          if (route.relation === 'manager' && question?.currentHandler
            && (question.currentHandler.kind !== 'session' || question.currentHandler.sessionId !== route.destinationSessionId)) continue;
          if (!resolveFollowDeliveryV1({ policies: [route.policy], event: evidence.event }).selected) continue;
          const candidate = candidates.get(route.destinationSessionId) ?? { policies: [], witnesses: [], relations: [] };
          candidate.policies.push(route.policy);
          candidate.relations.push(route.relation === 'manager'
            // The route response schema requires this attachment for managers.
            ? { relation: route.relation, attachedAt: route.attachedAt! }
            : { relation: route.relation, ...(route.attachedAt === undefined ? {} : { attachedAt: route.attachedAt }) });
          candidates.set(route.destinationSessionId, candidate);
        }
        // Assignment belongs to the original question, not to permanent W → G
        // membership. Merge its exact handler with all ordinary/rule reasons.
        if (handler?.kind === 'session' && handler.sessionId !== original.sourceSessionId
          && (!receiverSessionId || handler.sessionId === receiverSessionId)) {
          const candidate = candidates.get(handler.sessionId) ?? { policies: [], witnesses: [], relations: [] };
          const directManager = ordinary.routes.find(route => route.relation === 'manager' && route.destinationSessionId === handler.sessionId);
          candidates.set(handler.sessionId, { ...candidate, currentHandler: handler,
            policies: [...candidate.policies, directManager?.policy ?? opened.defaultPreferences?.managerPolicy
              ?? DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1.managerPolicy] });
        }
        for (const route of evaluated.routes) {
          if (receiverSessionId && (route.receiver.kind !== 'session' || route.receiver.sessionId !== receiverSessionId)) continue;
          const muted = route.receiver.kind === 'account'
            ? await readSessionDeliveryMutedScopes({ token: input.credentials.token, receiver: route.receiver,
              serverHttpBaseUrl: input.serverHttpBaseUrl, accountId: input.accountId, signal: input.signal })
            : await readSessionDeliveryMutedScopes({ token: input.credentials.token, receiver: route.receiver,
              serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal });
          if (!muted) {
            if (receiverSessionId) return;
            if (route.receiver.kind === 'account') personalRequestPassComplete = false;
            continue;
          }
          const sourceMuted = isFollowDeliveryMutedV1(muted, { senderSessionId: original.sourceSessionId,
            source: { kind: 'session', sessionId: original.sourceSessionId } });
          if (route.receiver.kind === 'account' && sourceMuted) continue;
          let contributions = route.rules.flatMap((rule, index) => isFollowDeliveryMutedV1(muted, { source: { kind: 'rule', ruleId: rule.ruleId } })
            || resolveSessionFollowSelectedDeliveryV1({ policies: [route.policies[index]!], event: evidence.event }) === null
            ? [] : [{ rule, policy: route.policies[index]! }]);
          // The final input owner retains a suppressed original in existing
          // discarded custody. Do not erase the sole reason before it can do
          // so; overlapping unmuted routes keep their ordinary selection.
          if (route.receiver.kind === 'session' && (sourceMuted || !contributions.length && !candidates.has(route.receiver.sessionId))) {
            contributions = route.rules.flatMap((rule, index) =>
              resolveSessionFollowSelectedDeliveryV1({ policies: [route.policies[index]!], event: evidence.event }) === null
                ? [] : [{ rule, policy: route.policies[index]! }]);
          }
          if (route.receiver.kind === 'account') {
            if ('sourceTurn' in original) {
              // Account effects describe the current terminal state. Its native
              // receipt orders the existing cue without advancing transcript progress.
              if (!terminalSourceMessage || !contributions.length || !('sourcePublisher' in original) || !await input.isPersonalCurrent()) continue;
              const publisher = original.sourcePublisher;
              const policies = contributions.map(item => item.policy);
              let accepted = false;
              await input.dispatchPersonal({ sourceSessionId: original.sourceSessionId, occurrence: original,
                policies, signal: input.signal, acceptDelivery: async () => {
                  if (!await current() || !await input.isPersonalCurrent()) return false;
                  const acceptance = await submitAccountFollowPersonalProgress({ token: input.credentials.token,
                    serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal, occurrence: {
                      sourceSessionId: original.sourceSessionId, sourceTurn: original.sourceTurn,
                      terminalSourceMessage,
                      expectedSourcePublisherGeneration: publisher.publisherGeneration,
                      machineId: input.machineId, installationId: input.installationId,
                      rules: contributions.map(({ rule }) => ({ ruleId: rule.ruleId, ruleVersion: rule.version })),
                    } });
                  accepted = acceptance?.accepted === true;
                  return accepted && acceptance?.alreadyRepresented === false;
                } }, async () => {
                  if (!await current()) return false;
                  const latestRoutes = await readRoutes(original, receiverSessionId);
                  if (latestRoutes === null || latestRoutes.currentAccountFacts?.personalFollowSuppressed === true) return false;
                  const latest = await rules.read();
                  return latest.status === 'available' && contributions.every(({ rule }) => latest.rules.some(candidate =>
                    candidate.ruleId === rule.ruleId && candidate.version === rule.version && candidate.definition.enabled));
                });
              if (accepted && nativePersonalOriginal) personalFollow = { sourceSessionId: original.sourceSessionId, accepted: true,
                sourceMessage: { ...nativePersonalOriginal.sourceMessage, policies } };
              continue;
            }
            const policies = [...contributions.map(item => item.policy), ...route.defaultPolicies ?? []];
            if (!await input.isPersonalCurrent()) {
              personalRequestPassComplete = false;
              continue;
            }
            if (policies.length && await current()) {
              if (!('sourcePublisher' in occurrence)) continue;
              if ('sourceRequests' in original) for (const { rule } of contributions) {
                const witness = personalRequestRules.get(rule.ruleId) ?? { ruleId: rule.ruleId,
                  ruleVersion: rule.version, requestIds: new Set<string>() };
                for (const request of original.sourceRequests.requests) witness.requestIds.add(request.requestId);
                personalRequestRules.set(rule.ruleId, witness);
              }
              const acceptance = 'sourceMessage' in original ? await submitAccountFollowPersonalProgress({ token: input.credentials.token,
                serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal,
                occurrence: { sourceSessionId: original.sourceSessionId,
                  expectedSourcePublisherGeneration: occurrence.sourcePublisher.publisherGeneration,
                  machineId: input.machineId, installationId: input.installationId,
                  rules: contributions.map(({ rule }) => ({ ruleId: rule.ruleId, ruleVersion: rule.version })),
                  sourceMessage: original.sourceMessage,
                } }) : null;
              const nativeOwner = 'sourceRequests' in original || evidence.event.kind === 'finished';
              if (!nativeOwner && acceptance?.accepted !== true) continue;
              const result = !nativeOwner && acceptance?.alreadyRepresented ? undefined
                : await input.dispatchPersonal({ sourceSessionId: original.sourceSessionId,
                  occurrence: original, policies, signal: input.signal }, async () => {
                  if (!await current()) return false;
                  const latestRoutes = await readRoutes(original, receiverSessionId);
                  if (latestRoutes === null || latestRoutes.currentAccountFacts?.personalFollowSuppressed === true) return false;
                  const latest = await rules.read();
                  return latest.status === 'available' && contributions.every(({ rule }) => latest.rules.some(candidate =>
                    candidate.ruleId === rule.ruleId && candidate.version === rule.version && candidate.definition.enabled));
                });
              const contribution = result?.personalFollow ?? (acceptance?.accepted && 'sourceMessage' in original
                ? { sourceSessionId: original.sourceSessionId,
                    sourceMessage: { ...original.sourceMessage, policies } } : undefined);
              if (contribution) {
                if (contribution.sourceSessionId !== original.sourceSessionId) throw new Error('personal_follow_source_mismatch');
                personalFollow = { sourceSessionId: original.sourceSessionId,
                  ...(acceptance?.accepted ? { accepted: true } : {}),
                  ...(contribution.sourceMessage ? { sourceMessage: contribution.sourceMessage } : {}),
                  ...((personalFollow?.requests || contribution.requests) ? {
                    requests: [...personalFollow?.requests ?? [], ...contribution.requests ?? []],
                  } : {}) };
              }
            }
            continue;
          }
          const candidate = candidates.get(route.receiver.sessionId) ?? { policies: [], witnesses: [], relations: [] };
          for (const { rule, policy } of contributions) {
            const selectedDelivery = resolveSessionFollowSelectedDeliveryV1({ policies: [policy], event: evidence.event });
            if (selectedDelivery === null) continue;
            const proof = 'sourcePublisher' in original ? {
                expectedSourcePublisherGeneration: original.sourcePublisher.publisherGeneration,
                machineId: input.machineId, installationId: input.installationId }
              : receiverSessionId ? { evaluation: 'receiver' as const } : null;
            if (!proof) continue;
            candidate.policies.push(policy);
            candidate.witnesses.push({ sourceSessionId: original.sourceSessionId, destinationSessionId: route.receiver.sessionId,
              ...proof,
              rule: { ruleId: rule.ruleId, ruleVersion: rule.version }, selectedDelivery,
              ...('sourceMessage' in original ? { sourceMessage: original.sourceMessage }
                : 'sourceTurn' in original ? { sourceTurn: original.sourceTurn } : { sourceRequests: original.sourceRequests }) });
          }
          candidates.set(route.receiver.sessionId, candidate);
        }
        checkpoint(diagnostic, 'selection', 'completed', { candidateCount: candidates.size });
        for (const [destinationSessionId, candidate] of candidates) {
          // Source publication and receiver catch-up share the existing input
          // owner. Do not re-offer a handler already in Pending/Message custody.
          if (candidate.currentHandler && ordinary.representedQuestionHandlerSessionId === destinationSessionId) continue;
          const selected = resolveFollowDeliveryV1({ policies: candidate.policies, event: evidence.event });
          if (!selected.selected || !await current()) continue;
          if (('sourceMessage' in original || 'sourceTurn' in original) && !fromSourceRange) {
            // A source notification can arrive after an earlier admission failed.
            // Reuse catch-up's ordered traversal before admitting this receiver's
            // next original; its own seq - 1 baseline cannot prove that prefix.
            await dispatchReceiverRange({ destinationSessionId, sourceSessionId: original.sourceSessionId,
              originalOccurrence: original,
              observations: ordinary.routes.filter(route => route.destinationSessionId === destinationSessionId) },
              'sourcePublisher' in original ? original.sourcePublisher : undefined);
            continue;
          }
          const common = { v: 1 as const, delivery: selected.session.wake ? 'wake' as const : 'next_turn' as const };
          const delivery: SessionFollowInputV1 = 'sourceMessage' in original
            ? { ...common, original: { sourceSessionId: original.sourceSessionId, sourceMessage: original.sourceMessage }, event: evidence.event }
            : 'sourceTurn' in original
              ? { ...common, original: { sourceSessionId: original.sourceSessionId, sourceTurn: original.sourceTurn },
                event: resolveSessionFollowTurnEventV1(original.sourceTurn) }
            : { ...common, original: { sourceSessionId: original.sourceSessionId, sourceRequests: {
                ...original.sourceRequests, ...(candidate.currentHandler ? { requests: original.sourceRequests.requests.map(request => ({
                  ...request, currentHandler: candidate.currentHandler,
                })) } : {}),
              } },
              requestEvents: original.requestEvidence.flatMap(item => item.evidence?.event.kind === 'needs_you'
                ? [{ requestId: item.requestId, event: item.evidence.event }] : []) };
          const representedRequests = 'sourceRequests' in delivery.original ? delivery.original.sourceRequests : null;
          const witnesses = representedRequests ? candidate.witnesses.map(witness => witness.sourceRequests
            ? { ...witness, sourceRequests: representedRequests } : witness) : candidate.witnesses;
          const admission = buildTrustedHostSessionInputAdmissionV1('agent');
          const features = await input.resolveServerFeaturesSnapshot?.();
          checkpoint({ ...diagnostic, destinationSessionId }, 'admission', 'started');
          const result = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, async () => await sendSessionMessage({
            credentials: input.credentials, idOrPrefix: destinationSessionId, wait: false,
            localId: deriveSessionFollowInputLocalIdV1({ destinationSessionId, original: delivery.original }),
            timeoutMs: resolveSessionMessageAdmissionTimeoutMs(), message: `Followed source changed. ${SESSION_FOLLOW_INFORMATION_NOTICE}`,
            inputAdmission: { provenance: admission.provenance, request: SessionInputRequestV1Schema.parse({ ...admission.request, followDeliveryV1: delivery }) },
            ...(witnesses.length ? { followSources: witnesses } : {}),
            ...(candidate.relations.length ? { followRelations: candidate.relations } : {}),
            informationDelivery: 'session_follow', executionAuthority: 'account_automation',
            resumeInactiveSession: selected.session.wake,
            ...(input.spawnSession ? { spawnSession: input.spawnSession } : {}),
            ...(features ? { serverFeaturesSnapshot: features } : {}), signal: input.signal,
          }));
          logger.debug('[Session Follow] Original admission completed', {
            sourceSessionId: original.sourceSessionId, destinationSessionId,
            ...('sourceMessage' in original ? { sourceMessageSeq: original.sourceMessage.seq }
              : 'sourceRequests' in original ? { agentStateVersion: original.sourceRequests.agentStateVersion,
                  requestId: original.sourceRequests.requests[0]?.requestId }
                : { sourceTurnId: original.sourceTurn.id }),
            ok: result.ok,
            ...(result.ok ? { localInputId: result.localId, suppressed: result.suppressed === true } : { code: result.code,
              ...(result.admissionResult && 'code' in result.admissionResult
                ? { admissionResultCode: result.admissionResult.code } : {}) }),
          });
          if (!result.ok) {
            workWaitingFor = 'receiver';
            logger.debug('[Session Follow] Original admission held', { code: result.code });
            if (receiverSessionId) return;
          }
          else {
            admittedWork = true;
            workOutcome = 'admitted';
            if (!result.suppressed && await current()) {
            const context = await input.resolveSourceKeyContext();
            if (context && await current()) await prepareSourceKey({ sourceSessionId: original.sourceSessionId,
              destinationSessionId, localInputId: result.localId, context, signal: input.signal });
            }
          }
        }
      }
      // A request-state version covers the complete source pass. Settle only
      // after every current original has contributed its eligible rule witness;
      // settling the first singleton would consume a same-version sibling.
      if (personalFollow?.requests?.length && personalRequestPassComplete && 'sourceRequests' in occurrence
        && 'sourcePublisher' in occurrence && await current()) {
        const acceptance = await submitAccountFollowPersonalProgress({ token: input.credentials.token,
          serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal,
          occurrence: { sourceSessionId: occurrence.sourceSessionId,
            expectedSourcePublisherGeneration: occurrence.sourcePublisher.publisherGeneration,
            machineId: input.machineId, installationId: input.installationId,
            sourceRequests: occurrence.sourceRequests,
            rules: [...personalRequestRules.values()].map(rule => ({ ...rule, requestIds: [...rule.requestIds] })),
          } });
        if (acceptance?.accepted) personalFollow = { ...personalFollow, accepted: true };
      }
      workOutcome = admittedWork ? 'admitted' : await current() ? 'settled' : 'held';
      return personalFollow ? { personalFollow } : {};
      } finally { finishWork?.(workOutcome, workWaitingFor); }
  };
  const dispatchReceiverRange = async (request: Readonly<{ destinationSessionId: string;
    observations: readonly SessionFollowSessionPendingObservationV1[]; sourceSessionId?: string;
    originalOccurrence?: SessionFollowRuleSourceOccurrenceV1 | SessionFollowAccountOccurrence }>,
    sourcePublisher?: SessionFollowRuleSourceOccurrenceV1['sourcePublisher']): Promise<SessionFollowReceiverRangeResult> => {
    const noOriginalTurns: SessionFollowSessionPendingObservationV1[] = [];
    const diagnostic = { entry: 'receiver_range' as const, destinationSessionId: request.destinationSessionId,
      ...(request.sourceSessionId ? { sourceSessionId: request.sourceSessionId } : {}) };
    checkpoint(diagnostic, 'currentness', 'started');
    if (!await current()) { checkpoint(diagnostic, 'currentness', 'held', { reason: 'account_not_current' }); return { receiverSessionIds: [] }; }
    // Receiver recovery re-reads configured Run sources. A source publisher's
    // notification repairs its own Session prefix without scanning other work.
    // A Run's retained original is never inferred from a parent turn.
    if (!sourcePublisher && !request.sourceSessionId && !request.originalOccurrence) {
      let cursor: string | undefined;
      do {
        const path = SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.list.replace(':destinationSessionId', encodeURIComponent(request.destinationSessionId));
        checkpoint(diagnostic, 'range_sources', 'started');
        const response = await axios.get(`${input.serverHttpBaseUrl}${path}`, { headers: { Authorization: `Bearer ${input.credentials.token}` },
          ...(cursor ? { params: { cursor } } : {}), signal: input.signal, validateStatus: () => true });
        const page = response.status === 200 ? ListSessionFollowSourcesResponseSchema.safeParse(response.data) : null;
        if (!page?.success || !await current()) {
          checkpoint(diagnostic, 'range_sources', 'held', { reason: !page?.success ? 'source_list_unavailable' : 'account_not_current',
            httpStatus: response.status }); break;
        }
        for (const relation of page.data.sources) if ('source' in relation
          && (relation.source.kind === 'execution_run' || relation.source.kind === 'workflow_run')
          && relation.deliveryState === 'eligible') await dispatchRun({ source: relation.source }, request.destinationSessionId);
        cursor = page.data.continuation;
      } while (cursor && await current());
    }
    // Empty recovery has no Session work without an enabled receiver rule.
    if (!request.originalOccurrence && request.observations.length === 0
      && !await rules.hasEnabledSessionReceiver(request.destinationSessionId)) return { receiverSessionIds: [] };
    // Configuration is loaded once and withdrawn by the Account feed.
    // Progress and first-prefix discovery are read separately below.
    checkpoint(diagnostic, 'rules', 'started');
    const opened = await rules.read();
    if (opened.status !== 'available') { checkpoint(diagnostic, 'rules', 'held', { reason: opened.reason }); return { receiverSessionIds: [] }; }
    if (!await current()) { checkpoint(diagnostic, 'rules', 'held', { reason: 'account_not_current' }); return { receiverSessionIds: [] }; }
    checkpoint(diagnostic, 'rules', 'completed');
    const receiverRules = new Map(opened.rules.filter(rule => rule.definition.enabled && rule.receiver.kind === 'session'
      && rule.receiver.sessionId === request.destinationSessionId).map(rule => [rule.ruleId, rule.version]));
    const receiverRulesEnabled = receiverRules.size > 0;
    let admittedOriginal = request.originalOccurrence;
    const refreshForOriginal = async (originalOccurrence: SessionFollowRuleSourceOccurrenceV1 | SessionFollowAccountOccurrence) => {
      if (admittedOriginal || receiverRulesEnabled) return null;
      // A configuration push may have arrived during source traversal.
      // Rebuild from that snapshot before any effect if it added receiver rules;
      // the original itself never forces another configuration census.
      const refreshed = await rules.read();
      if (refreshed.status !== 'available' || !await current()) return { receiverSessionIds: [] };
      admittedOriginal = originalOccurrence;
      // If current configuration still has no receiver rules, the already
      // opened ordinary range is unchanged and needs no second transcript read.
      return refreshed.rules.some(rule => rule.definition.enabled && rule.receiver.kind === 'session'
        && rule.receiver.sessionId === request.destinationSessionId)
        ? dispatchReceiverRange({ ...request, originalOccurrence }, sourcePublisher) : null;
    };
    const ranges = new Map<string, { afterSeq: number; throughSeq: number | null; afterStateVersion: number }>();
    const applied = new Map<string, SessionFollowFrontierV1>();
    const observeApplied = (sourceSessionId: string, delivered: SessionFollowFrontierV1) => {
      const previous = applied.get(sourceSessionId);
      applied.set(sourceSessionId, previous ? {
        transcriptSeq: Math.min(previous.transcriptSeq, delivered.transcriptSeq),
        readyEventSeq: Math.min(previous.readyEventSeq, delivered.readyEventSeq),
        agentStateVersion: Math.min(previous.agentStateVersion, delivered.agentStateVersion),
        turn: isSessionFollowTurnEqualV1(previous.turn, delivered.turn) ? previous.turn : null,
      } : delivered);
    };
    for (const observation of request.observations) {
      if (request.sourceSessionId && request.sourceSessionId !== observation.sourceSessionId) continue;
      observeApplied(observation.sourceSessionId, observation.delivered);
      // Ordinary observations demand a range only for an unconsumed frontier.
      // Proved originals and configured rules below retain their independent
      // prefix/discovery demand, even when an ordinary edge is already current.
      if (!request.originalOccurrence && isSessionFollowFrontierEqualV1(observation.delivered, observation.observed)) continue;
      const range = ranges.get(observation.sourceSessionId);
      ranges.set(observation.sourceSessionId, { afterSeq: Math.min(range?.afterSeq ?? observation.delivered.transcriptSeq,
        observation.delivered.transcriptSeq), throughSeq: Math.max(range?.throughSeq ?? 0, observation.observed.transcriptSeq),
        afterStateVersion: Math.min(range?.afterStateVersion ?? observation.delivered.agentStateVersion, observation.delivered.agentStateVersion) });
    }
    let progressRules: SessionFollowReceiverSourceRanges['rules'] = opened.rules;
    let discoveredRanges: ListSessionFollowRulesResponseV1['sourceRanges'];
    if (receiverRulesEnabled) {
      checkpoint(diagnostic, 'source_ranges', 'started');
      const progress = await rules.readReceiverSourceRanges({ destinationSessionId: request.destinationSessionId,
        ...(request.sourceSessionId ? { sourceSessionId: request.sourceSessionId } : {}) });
      if (!await current() || progress.status === 'unavailable' && progress.reason === 'account-retired') {
        checkpoint(diagnostic, 'source_ranges', 'held', { reason: 'account_not_current' }); return { receiverSessionIds: [] };
      }
      if (progress.status === 'unavailable') checkpoint(diagnostic, 'source_ranges', 'held', {
        reason: 'source_ranges_unavailable', ...(progress.httpStatus === undefined ? {} : { httpStatus: progress.httpStatus }),
      });
      else {
        // A successful narrow read replaces cached cursors, including removed
        // sources. Cached authoring stays authoritative until its push update.
        progressRules = progress.value.rules;
        discoveredRanges = progress.value.sourceRanges;
        checkpoint(diagnostic, 'source_ranges', 'completed');
      }
    }
    for (const rule of progressRules) {
      if (receiverRules.get(rule.ruleId) !== rule.version || rule.receiver.kind !== 'session'
        || rule.receiver.sessionId !== request.destinationSessionId) continue;
      // A retained encountered prefix can still be traversed when discovery is
      // unavailable. Final original admission owns authority and progress.
      for (const source of rule.sources ?? []) {
        if (request.sourceSessionId && request.sourceSessionId !== source.sourceSessionId) continue;
        observeApplied(source.sourceSessionId, source.delivered);
        const range = ranges.get(source.sourceSessionId);
        ranges.set(source.sourceSessionId, { afterSeq: Math.min(range?.afterSeq ?? source.delivered.transcriptSeq,
          source.delivered.transcriptSeq), throughSeq: null,
          afterStateVersion: Math.min(range?.afterStateVersion ?? source.delivered.agentStateVersion, source.delivered.agentStateVersion) });
      }
    }
    for (const source of discoveredRanges?.sources ?? []) {
      if (request.sourceSessionId && request.sourceSessionId !== source.sourceSessionId) continue;
      observeApplied(source.sourceSessionId, source.delivered);
      const range = ranges.get(source.sourceSessionId);
      // The held discovery baseline stays valid until accepted progress changes.
      // Its old observed end must not hide a later original: the same fresh
      // source-detail read below owns this pass's transcript end.
      ranges.set(source.sourceSessionId, { afterSeq: Math.min(range?.afterSeq ?? source.delivered.transcriptSeq,
        source.delivered.transcriptSeq), throughSeq: null,
        afterStateVersion: Math.min(range?.afterStateVersion ?? source.delivered.agentStateVersion,
          source.delivered.agentStateVersion) });
    }
    for (const [sourceSessionId, delivered] of applied) {
      // Prune only the union's lowest applied frontier. A newer ordinary edge
      // or rule must not erase custody still needed by another contributing rule.
      rules.originalWork.observed(request.destinationSessionId, sourceSessionId, delivered);
    }
    for (const [sourceSessionId, range] of ranges) {
      if (!await current()) continue;
      checkpoint(diagnostic, 'range_transport', 'started', { sourceSessionId, afterSeq: range.afterSeq });
      const transport = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => resolveSessionTransportContext({ reason: 'follow-occurrence',
        credentials: input.credentials, idOrPrefix: sourceSessionId, signal: input.signal }));
      if (!transport.ok || !await current()) {
        checkpoint(diagnostic, 'range_transport', 'held', { sourceSessionId,
          reason: !transport.ok ? transport.code : 'account_not_current' }); continue;
      }
      const ownerAccountId = transport.rawSession.ownerAccountId;
      if (typeof ownerAccountId !== 'string') continue;
      const source = transport.rawSession;
      const readSourceFacts = createSessionFollowSourceFactsRead({ credentials: input.credentials,
        accountEncryption: transport.accountEncryptionCurrentness, row: source, serverId: input.serverId,
        accountId: input.accountId, serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal, isCurrent: current });
      const throughSeq = range.throughSeq ?? source.seq;
      if (typeof source.agentStateVersion === 'number' && source.agentStateVersion > range.afterStateVersion && source.agentStateVersion > 0 && typeof source.agentState === 'string') {
        const ctx = transport.ctx;
        const openedState = await openSessionStateValue(transport.mode === 'plain' ? { mode: 'plain' } : {
          mode: 'e2ee', encryption: ctx ? {
            encryptRaw: async payload => encryptSessionPayload({ ctx, payload }),
            decryptRaw: async ciphertextBase64 => decryptSessionPayload({ ctx, ciphertextBase64 }),
          } : null,
        }, source.agentState);
        const state = openedState.status === 'ready' ? AgentStateSchema.safeParse(openedState.value) : null;
        if (state?.success) for (const [requestId, foregroundRequest] of readActiveForegroundAgentRequests(state.data)) {
          if (typeof foregroundRequest.createdAt !== 'number' || !Number.isFinite(foregroundRequest.createdAt)) continue;
          const event = readForegroundAgentRequestFollowEvent(foregroundRequest);
          const evidence = event ? captureSemanticSessionFollowRuleSourceEvidence({ serverId: input.serverId,
            ownerAccountId, origin: source.origin ?? null, event }) : null;
          if (!evidence || !await current()) continue;
          const originalOccurrence = { sourceSessionId, sourceRequests: { agentStateVersion: source.agentStateVersion,
            requests: [{ requestId, createdAt: foregroundRequest.createdAt, ...(foregroundRequest.turnId ? { turnId: foregroundRequest.turnId } : {}) }] },
            requestEvidence: [{ requestId, evidence }], ...(sourcePublisher ? { sourcePublisher } : {}) };
          const refreshed = await refreshForOriginal(originalOccurrence);
          if (refreshed) return refreshed;
          await dispatch(originalOccurrence, request.destinationSessionId, true, undefined, undefined, transport, readSourceFacts);
        }
      }
      let afterSeq = range.afterSeq;
      let sourceRangeAvailable = true;
      const terminalOccurrences = new Map<string, Readonly<{
        occurrence: Extract<SessionFollowAccountOccurrence, { sourceTurn: unknown }>;
        terminalSourceMessage?: TerminalSourceMessage;
      }>>();
      while (afterSeq < throughSeq && await current()) {
        const pageStart = afterSeq;
        checkpoint(diagnostic, 'range_transcript', 'started', { sourceSessionId, afterSeq, throughSeq });
        // Frontiers count sidechain rows too; the occurrence reader excludes their events.
        const page = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => fetchEncryptedTranscriptMessagesPage({
          token: input.credentials.token, sessionId: sourceSessionId, afterSeq, scope: 'all',
          limit: SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1, signal: input.signal }));
        if (!await current()) break;
        let unavailable = false;
        for (const row of page.messages) {
          if (typeof row.seq === 'number' && row.seq > throughSeq) break;
          const read = readCommittedSessionFollowSourceOccurrence({ sourceSessionId, serverId: input.serverId,
            ownerAccountId, origin: transport.rawSession.origin ?? null,
            row, mode: transport.mode, ctx: transport.ctx });
          if (read.status === 'unavailable') {
            checkpoint(diagnostic, 'range_transcript', 'held', { sourceSessionId, reason: 'source_row_unavailable',
              ...(typeof row.seq === 'number' ? { sourceMessageSeq: row.seq } : {}) });
            unavailable = true; break;
          }
          if (read.status === 'occurrence' && !('sourceRequests' in read.occurrence)) {
            if ('sourceTurn' in read.occurrence) {
              terminalOccurrences.set(read.occurrence.sourceTurn.id, { occurrence: read.occurrence,
                ...(row.localId ? { terminalSourceMessage: { localId: row.localId, seq: row.seq } } : {}) });
              if (typeof row.seq === 'number') afterSeq = row.seq;
              continue;
            }
            const originalOccurrence = { ...read.occurrence, ...(sourcePublisher ? { sourcePublisher } : {}) };
            const refreshed = await refreshForOriginal(originalOccurrence);
            if (refreshed) return refreshed;
            const dispatched = await dispatch(originalOccurrence, request.destinationSessionId, true, undefined, undefined, transport, readSourceFacts, row.updatedAt);
            // A later original's accepted ACK advances this same source cursor.
            // Leave the suffix for the next existing catch-up boundary when
            // this original's admission is unavailable or unconfirmed.
            if (!dispatched) { unavailable = true; break; }
          }
          if (typeof row.seq === 'number') afterSeq = row.seq;
        }
        if (unavailable) sourceRangeAvailable = false;
        if (unavailable || !page.hasMore || page.nextAfterSeq === null || page.nextAfterSeq <= pageStart) break;
        afterSeq = page.nextAfterSeq;
      }
      // Source traversal first preserves publication order. Terminal lifecycle
      // and exact native ready evidence then share the same Turn original.
      if (sourceRangeAvailable && afterSeq >= throughSeq && await current()) {
        const terminal = SessionFollowSourceTurnV1Schema.safeParse({ id: source.latestTurnId, status: source.latestTurnStatus });
        if (terminal.success) {
          const evidence = captureSemanticSessionFollowRuleSourceEvidence({ serverId: input.serverId, ownerAccountId,
            origin: source.origin ?? null, event: resolveSessionFollowTurnEventV1(terminal.data) });
          if (evidence && !terminalOccurrences.has(terminal.data.id)) {
            terminalOccurrences.set(terminal.data.id, { occurrence: { sourceSessionId, sourceTurn: terminal.data, evidence } });
          }
        }
        for (const { occurrence, terminalSourceMessage } of terminalOccurrences.values()) {
          // Terminal identity has no numeric range cursor. The same common
          // applied witness that retires custody excludes its completed work
          // from this pass, rather than recreating a settled history entry.
          if (isSessionFollowTurnEqualV1(applied.get(sourceSessionId)?.turn ?? null, occurrence.sourceTurn)) continue;
          const originalOccurrence = { ...occurrence, ...(sourcePublisher ? { sourcePublisher } : {}) };
          const refreshed = await refreshForOriginal(originalOccurrence);
          if (refreshed) return refreshed;
          await dispatch(originalOccurrence, request.destinationSessionId, true, undefined, terminalSourceMessage, transport, readSourceFacts);
        }
        const presence = SessionFollowStalledOccurrenceV1Schema.safeParse({ turnId: source.latestTurnId, publisherFence: source.activeAt });
        if (receiverRulesEnabled && presence.success && isSessionFollowStalledOccurrenceCurrentV1(presence.data, source)) {
          const facts = await readCliSessionListFilterFactsV1({ credentials: input.credentials,
            accountEncryption: transport.accountEncryptionCurrentness, row: source, serverId: input.serverId,
            nowMs: Date.now(), accountId: input.accountId, serverHttpBaseUrl: input.serverHttpBaseUrl,
            signal: input.signal, isCurrent: current,
            filters: opened.rules.filter(rule => receiverRules.get(rule.ruleId) === rule.version).map(rule => rule.definition.filter) });
          const selected = facts && evaluateSessionFollowRuleOccurrenceV1({ accountId: input.accountId, evaluator: 'receiver',
            production: 'recovery', sourceSessionId, evidence: { ownerAccountId, event: { kind: 'stalled' } },
            // Presence's fence identifies the last publisher, not when its
            // later offline transition became a current stalled occurrence.
            currentFacts: facts, rules: opened.rules.filter(rule => receiverRules.get(rule.ruleId) === rule.version) });
          if (selected && selected.status === 'evaluated') for (const route of selected.routes) {
            if (route.receiver.kind !== 'session' || route.receiver.sessionId !== request.destinationSessionId) continue;
            const selections = route.rules.flatMap((rule, index) => {
              const selectedDelivery = resolveSessionFollowSelectedDeliveryV1({ policies: [route.policies[index]!], event: { kind: 'stalled' } });
              return selectedDelivery ? [{ ruleId: rule.ruleId, ruleVersion: rule.version, selectedDelivery }] : [];
            });
            if (!selections.length || !await current()) continue;
            const admitted = await submitAccountFollowPersonalProgress({ token: input.credentials.token,
              serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal,
              occurrence: { kind: 'session_stalled', sourceSessionId, destinationSessionId: request.destinationSessionId,
                presence: presence.data, rules: selections } });
            if (!admitted?.accepted || admitted.alreadyRepresented || !await current()) continue;
            // The private owner rechecks mute/version and publishes this aggregate.
            // The host's observe/dispatch/ACK owners recheck it again before use.
            if (transport.mode !== 'plain') {
              const context = await input.resolveSourceKeyContext();
              if (context) await prepareSourceKey({ context, sourceSessionId, destinationSessionId: request.destinationSessionId, signal: input.signal });
            }
            noOriginalTurns.push({ sourceSessionId, destinationSessionId: request.destinationSessionId, relation: 'rule',
              effectiveDelivery: route.delivery.session.wake ? 'wake' : 'next_turn', presence: presence.data,
              delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1,
              observed: projectSessionFollowFrontierFromSourceV1(source) });
          }
        }
        for (const observation of request.observations) if (observation.sourceSessionId === sourceSessionId
          && (observation.observed.turn?.status === 'stalled' || observation.relation === 'manager')
          && !noOriginalTurns.some(pending => pending.sourceSessionId === sourceSessionId && pending.relation === observation.relation)) {
          noOriginalTurns.push(observation);
        }
      }
    }
    // Offer every source original before attempting the receiver's one
    // context-only resume, as the former bootstrap caller did.
    for (const observation of noOriginalTurns) {
      if (await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => dispatchNoOriginalTurn(observation))) break;
    }
    checkpoint(diagnostic, 'range', 'completed');
    return { receiverSessionIds: [] };
  };
  return {
    dispose: () => { accountSourceProjectionRead = Promise.resolve(null);
      accountSourceInterests.clear(); accountSessionRunInterests.clear(); if (!input.rulesCache) rules.dispose();
      if (!input.runRoutes) runRoutes.dispose(); },
    async dispatchExecutionRunSourceChange(source: Extract<RunFollowOriginalV1['source'], { kind: 'execution_run' }>, includeRun = true) {
      await runRoutes.available(source, 'exact_run');
      if (includeRun) await dispatchRun({ source }, undefined, false, 'exact_run');
      await dispatchAccountSourceRange({ source, outputsOnly: true });
    },
    dispatch: async (occurrence: SessionFollowRuleSourceOccurrenceV1 | SessionFollowRunOccurrence) => {
      if ('original' in occurrence) {
        if (occurrence.original.source.kind === 'execution_run') await runRoutes.available(occurrence.original.source, 'exact_run');
        return dispatchRun(occurrence, undefined, false, occurrence.original.source.kind === 'execution_run' ? 'exact_run' : undefined);
      }
      return dispatch(occurrence);
    },
    dispatchReceiver: (request: Readonly<{ occurrence: SessionFollowAccountOccurrence; destinationSessionId: string }>) =>
      dispatch(request.occurrence, request.destinationSessionId),
    dispatchReceiverRange,
    dispatchAccountSourceRange,
    async readReceiverSessionIds(sourceSessionId?: string, availabilityChanged?: boolean, sourceChanged = true): Promise<readonly string[]> {
      if (!await current()) return [];
      const heldReceiver = sourceSessionId && availabilityChanged !== false
        && rules.originalWork.hasHeldReceiver(sourceSessionId) ? sourceSessionId : undefined;
      if (sourceSessionId) {
        rules.observeSourceChange(sourceSessionId, undefined, availabilityChanged, sourceChanged ? undefined : false);
      }
      if (!sourceChanged) return heldReceiver ? [heldReceiver] : [];
      const opened = await rules.read();
      if (!await current()) return [];
      if (opened.status !== 'available') return heldReceiver ? [heldReceiver] : [];
      let candidates = opened.rules.filter(rule => rule.definition.enabled && rule.receiver.kind === 'session'
        && rule.receiver.sessionId !== sourceSessionId);
      if (sourceSessionId && candidates.length) {
        const homeId = await resolveServerProfileHomeIdentityId(input.serverId);
        const serverId = homeId ?? input.serverId;
        if (!await current()) return [];
        // Discovery already knows the source Home and kind. The canonical
        // matcher can decide some rules without reading a mutable Session row;
        // only unavailable predicates need fresh source/supplemental facts.
        const known = candidates.map(rule => ({ rule,
          // An identical local profile is the existing in-process target
          // contract. Otherwise an unresolved portable Home is not a miss.
          match: homeId !== null || rule.definition.filter.homeServerIds.includes(input.serverId)
            ? matchSessionListFilterV1(rule.definition.filter, {
              serverId, kind: 'session', workspaceContext: { normalizeServerId: id => id === input.serverId ? serverId : id },
            }, 'daemonRule') : 'unavailable' as const,
        }));
        candidates = known.filter(candidate => candidate.match !== 'miss').map(candidate => candidate.rule);
        const unresolved = known.filter(candidate => candidate.match === 'unavailable').map(candidate => candidate.rule);
        if (unresolved.length) {
          const [encryption, source] = await Promise.allSettled([
            fetchAccountEncryptionCurrentness({ token: input.credentials.token, serverBaseUrl: input.serverHttpBaseUrl, signal: input.signal }),
            fetchSessionById({ reason: 'follow-occurrence', token: input.credentials.token, sessionId: sourceSessionId,
              serverUrl: input.serverHttpBaseUrl, signal: input.signal }),
          ]);
          if (!await current()) return [];
          if (encryption.status === 'fulfilled' && source.status === 'fulfilled' && source.value) {
            const facts = await readCliSessionListFilterFactsV1({ credentials: input.credentials, accountEncryption: encryption.value,
              row: source.value, serverId: input.serverId, nowMs: Date.now(), accountId: input.accountId,
              serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal, isCurrent: current,
              filters: unresolved.map(rule => rule.definition.filter) });
            // A known miss suppresses discovery only. Unknown facts retain the
            // receiver, and actual dispatch still proves rules and source fresh.
            if (facts) candidates = candidates.filter(rule => matchSessionListFilterV1(rule.definition.filter, facts, 'daemonRule') !== 'miss');
          }
        }
      }
      return await current() ? [...new Set([...(heldReceiver ? [heldReceiver] : []), ...candidates
        .flatMap(rule => rule.receiver.kind === 'session' ? [rule.receiver.sessionId] : [])])] : [];
    },
  };
}
