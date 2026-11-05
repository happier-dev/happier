import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { UsageWorkPermissionFact, UsageWorkIntervalFact } from './usageWorkIntervals.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { readUsageAccountingSessionMembership, type UsageAccountingSessionMembership } from './usageAccountingMembership.js';
export { UsageAccountingSessionMembershipSchema, projectUsageAccountingSessionMembership, readUsageAccountingSessionMembership,
    type UsageAccountingSessionMembership } from './usageAccountingMembership.js';
import type { UsageHowYouWorkDetailInput } from '../usage/resolveUsageHowYouWork.js';
import { SessionPermissionAnsweringClientCategoryV1Schema } from '../sessions/permissions/respondRpcParamsV1.js';
import { SessionActionConfirmationsV1Schema } from '../sessions/metadata/sessionActionConfirmationsV1.js';
import { SessionOwnerCompatibilityViewV1Schema } from '../sessions/metadata/sessionMetadataSchemasV1.js';
import { TranscriptRawAgentEventV1Schema, TranscriptRawAgentRecordV1Schema, type TranscriptRawAgentEventV1 } from '../sessions/messages/transcriptRawRecordV1.js';
import { UsageCoachModelRequestSchema, type UsagePromptComposition, type UsageCoachModelRequest } from '../usage/coach/usagePromptComposition.js';
import type { UsageCoachCompactionFact } from '../usage/coach/coachFinding.js';
import type { UsageMcpBindingUsage } from '../usage/coach/usageMcpBindingUsage.js';
import type { UsageQuery } from '../inputs/usageQuery.js';
import type { UsageAnalyticsContribution } from '../usage/usageAnalyticsContracts.js';
import { canonicalUsageModelPriceId } from '../usage/usageModelPriceSchemas.js';
import { resolveToolMutationClassification } from '../tools/toolMutationClassification.js';
import type { SessionTurnsProjectionV1 } from '../sessions/turns/sessionTurnV1.js';
import type { SessionMessageAcceptedDeliveryFactsV1 } from '../sessions/messages/sessionMessageDeliveryResolutionV1.js';
import type { SessionAwarenessOriginV1 } from '../sessions/awareness/projectionV1.js';
import { projectSessionUsageCollaboration, projectUsageCollaborationToolPayload, readUsageCollaborationMetadata,
    resolveUsageCollaborationHistoricalSource, type UsageCollaborationToolEvidence } from './usageCollaboration.js';
export { USAGE_COLLABORATION_TOOL_LEAF_KEYS, projectUsageCollaborationToolPayload } from './usageCollaboration.js';
import type { UsageSessionTimingV1, UsageTimingBoundsV1 } from './usageTimingV1.js';
export { UsageTimingBoundsV1Schema, UsageSessionTimingV1Schema, mergeUsageTimingBoundsV1,
    type UsageTimingBoundsV1, type UsageSessionTimingV1 } from './usageTimingV1.js';

export type OpenedUsageSession = Readonly<{
    id: string;
    createdAt?: number;
    origin?: SessionAwarenessOriginV1;
    manager?: Readonly<{ sessionId: string }> | null;
    metadata: Readonly<{ machineId?: string; actionConfirmationsV1?: unknown;
        forkV1?: Readonly<{ parentSessionId: string; createdAtMs: number }>;
        replaySeedV1?: Readonly<{ sourceSessionId: string; createdAtMs: number }>;
        handoffV1?: Readonly<{ sourceMachineId: string; targetMachineId: string; agentId: string; completedAtMs: number }>;
    }> | null;
    agentState: Readonly<{
        requests?: Readonly<Record<string, Readonly<{ tool: string; kind?: string; turnId?: string; createdAt?: number | null }>>> | null;
        completedRequests?: Readonly<Record<string, Readonly<{ tool: string; kind?: string; turnId?: string; createdAt?: number | null;
            completedAt?: number | null; status: string; answeringClientCategory?: unknown }>>> | null;
    }> | null;
    stateEvidence?: UsageSessionStateEvidence;
    sessionTurns?: SessionTurnsProjectionV1 | null;
}>;
export type OpenedUsageMessage = Readonly<{ id: string; localId?: string | null; acceptedDelivery?: SessionMessageAcceptedDeliveryFactsV1 | null;
    content?: unknown; createdAt?: number }>;
/** Already-admitted message witnesses; native bodies are opened only at their trust boundary. */
export type UsageSessionMessageProjection = Readonly<{
    id: string; localId?: string | null; createdAt?: number; acceptedDelivery?: SessionMessageAcceptedDeliveryFactsV1 | null;
    nativeAgentId: string | null;
    sidechainIds: readonly string[];
    tools: readonly Readonly<{ kind: 'call' | 'result'; id: string; name: string; input?: unknown; result?: unknown }>[];
    event?: TranscriptRawAgentEventV1;
    eventId?: string;
}>;
/** Content-free facts retained after opened transcript bodies have been released. */
export type UsageSessionMessageEvidence = Pick<UsageHowYouWorkDetailInput, 'acceptedInputs' | 'phaseEvents' | 'coach' | 'collaboration'>;
const storedEventSchema = createStoredReadSchema(TranscriptRawAgentEventV1Schema);
const confirmationReadSchema = createStoredReadSchema(SessionActionConfirmationsV1Schema);
const timingMetadataReadSchema = lazyZodSchema(() => createStoredReadSchema(z.strictObject({
    forkV1: SessionOwnerCompatibilityViewV1Schema.shape.forkV1,
    replaySeedV1: SessionOwnerCompatibilityViewV1Schema.shape.replaySeedV1,
    handoffV1: SessionOwnerCompatibilityViewV1Schema.shape.handoffV1,
    actionConfirmationsV1: SessionOwnerCompatibilityViewV1Schema.shape.actionConfirmationsV1,
})));

export type UsageSessionStateEvidence = Readonly<{
    permissions: readonly UsageWorkPermissionFact[];
    waits: readonly UsageWorkIntervalFact[];
}>;
const StateTime = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
export const UsageSessionPermissionRequestProjectionSchema = lazyZodSchema(() => z.strictObject({
    tool: z.string(), kind: z.optional(z.string()), turnId: z.optional(z.string()),
    createdAt: z.optional(z.nullable(StateTime)),
}));
export type UsageSessionPermissionRequestProjection = z.infer<typeof UsageSessionPermissionRequestProjectionSchema>;
export type UsageSessionPermissionCompletedProjection = UsageSessionPermissionRequestProjection & Readonly<{
    completedAt?: number | null; status: string; answeringClientCategory?: unknown;
}>;
export const UsageSessionPermissionCompletedProjectionSchema = lazyZodSchema(() => z.safeExtend(UsageSessionPermissionRequestProjectionSchema, {
    completedAt: z.optional(z.nullable(StateTime)), status: z.string(),
    answeringClientCategory: z.optional(z.catch(z.nullable(SessionPermissionAnsweringClientCategoryV1Schema), null)),
})) satisfies z.ZodMiniType<UsageSessionPermissionCompletedProjection>;
const timingStateReadSchema = lazyZodSchema(() => createStoredReadSchema(z.strictObject({
    requests: z.optional(z.nullable(z.record(z.string(), UsageSessionPermissionRequestProjectionSchema))),
    completedRequests: z.optional(z.nullable(z.record(z.string(), UsageSessionPermissionCompletedProjectionSchema))),
})));

function* readUsagePermissionEntries(
    requests: Readonly<Record<string, UsageSessionPermissionRequestProjection>>,
    completedRequests: Readonly<Record<string, UsageSessionPermissionCompletedProjection>>,
) {
    for (const [requestId, entry] of Object.entries({ ...requests, ...completedRequests })) {
        const completion = completedRequests[requestId];
        const category = SessionPermissionAnsweringClientCategoryV1Schema.safeParse(completion?.answeringClientCategory);
        yield { requestId, entry, completion,
            turnId: typeof entry.turnId === 'string' && entry.turnId.trim() ? entry.turnId : null,
            requestedAtMs: timestamp(entry.createdAt), completedAtMs: completion ? timestamp(completion.completedAt) : null,
            answeringClientCategory: category.success ? category.data : null };
    }
}

/** Fold admitted request leaves; private arguments and provider state are not inputs. */
export function projectUsageSessionStateEvidenceFromRequests(input: Readonly<{
    sessionId: string; machineId: string | null;
    turns: readonly Pick<SessionTurnsProjectionV1['turns'][number], 'turnId' | 'agentId'>[];
    requests: Readonly<Record<string, UsageSessionPermissionRequestProjection>>;
    completedRequests: Readonly<Record<string, UsageSessionPermissionCompletedProjection>>;
}>): UsageSessionStateEvidence {
    const permissions: UsageWorkPermissionFact[] = [];
    const waits: UsageWorkIntervalFact[] = [];
    for (const { requestId, entry, completion, turnId, requestedAtMs, completedAtMs, answeringClientCategory }
        of readUsagePermissionEntries(input.requests, input.completedRequests)) {
        const workId = JSON.stringify([input.sessionId, turnId]);
        permissions.push({ requestId, workId, requestedAtMs,
            decidedAtMs: completion && completion.status !== 'canceled' ? completedAtMs : null,
            toolId: entry.tool || null, answeringClientCategory });
        if (turnId && requestedAtMs !== null) waits.push({ workId, evidenceId: requestId,
            agentId: input.turns.find(turn => turn.turnId === turnId)?.agentId ?? null, machineId: input.machineId,
            kind: entry.kind === 'user_action' ? 'user_wait' : 'permission_wait', startMs: requestedAtMs, endMs: completedAtMs });
    }
    return { permissions, waits };
}

function readUsageSessionStateEvidence(session: OpenedUsageSession) {
    const confirmations = confirmationReadSchema.safeParse(session.metadata?.actionConfirmationsV1);
    return { known: session.agentState?.requests != null || session.agentState?.completedRequests != null || confirmations.success,
        evidence: projectUsageSessionStateEvidenceFromRequests({ sessionId: session.id, machineId: session.metadata?.machineId ?? null,
            turns: session.sessionTurns?.sessionId === session.id ? session.sessionTurns.turns : [],
            requests: { ...(confirmations.success ? confirmations.data.requests : {}), ...session.agentState?.requests },
            completedRequests: { ...(confirmations.success ? confirmations.data.completedRequests : {}), ...session.agentState?.completedRequests },
        }) };
}

/** Existing opened full-state adapter; the typed SQL path uses the same fold above. */
export function projectUsageSessionStateEvidence(session: OpenedUsageSession): UsageSessionStateEvidence {
    return readUsageSessionStateEvidence(session).evidence;
}

/** Retain consumed facts after the owning reader admits and opens a Session. */
export function projectUsageSessionInput(session: OpenedUsageSession): OpenedUsageSession {
    const state = session.stateEvidence === undefined ? readUsageSessionStateEvidence(session) : null;
    const stateEvidence = session.stateEvidence ?? (state?.known ? state.evidence : undefined);
    const metadata = session.metadata;
    return {
        id: session.id,
        ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
        ...(session.origin === undefined ? {} : { origin: session.origin }),
        ...(session.manager === undefined ? {} : { manager: session.manager ? { sessionId: session.manager.sessionId } : null }),
        metadata: metadata ? {
            ...(metadata.machineId === undefined ? {} : { machineId: metadata.machineId }),
            ...(metadata.forkV1 ? { forkV1: { parentSessionId: metadata.forkV1.parentSessionId,
                createdAtMs: metadata.forkV1.createdAtMs } } : {}),
            ...(metadata.replaySeedV1 ? { replaySeedV1: { sourceSessionId: metadata.replaySeedV1.sourceSessionId,
                createdAtMs: metadata.replaySeedV1.createdAtMs } } : {}),
            ...(metadata.handoffV1 ? { handoffV1: { sourceMachineId: metadata.handoffV1.sourceMachineId,
                targetMachineId: metadata.handoffV1.targetMachineId, agentId: metadata.handoffV1.agentId,
                completedAtMs: metadata.handoffV1.completedAtMs } } : {}),
        } : null,
        agentState: null,
        ...(stateEvidence === undefined ? {} : { stateEvidence }),
        ...(session.sessionTurns === undefined ? {} : { sessionTurns: session.sessionTurns }),
    };
}

function usageTimingBounds(points: readonly (number | null)[], open = false): UsageTimingBoundsV1 | null {
    let minMs: number | null = null;
    let maxMs: number | null = null;
    for (const point of points) {
        const instant = timestamp(point);
        if (instant === null) return null;
        minMs = minMs === null ? instant : Math.min(minMs, instant);
        maxMs = maxMs === null ? instant : Math.max(maxMs, instant);
    }
    return minMs === null ? { v: 1, minMs: null, maxMs: null } : { v: 1, minMs, maxMs: open ? null : maxMs };
}

function permissionTiming(
    requests: Readonly<Record<string, UsageSessionPermissionRequestProjection>>,
    completedRequests: Readonly<Record<string, UsageSessionPermissionCompletedProjection>>,
): UsageTimingBoundsV1 | null {
    const points: number[] = [];
    let open = false;
    for (const entry of readUsagePermissionEntries(requests, completedRequests)) {
        if (entry.requestedAtMs !== null) points.push(entry.requestedAtMs);
        if (entry.completedAtMs !== null) points.push(entry.completedAtMs);
        if (entry.turnId && entry.requestedAtMs !== null && entry.completedAtMs === null) open = true;
    }
    return usageTimingBounds(points, open);
}

/** Publish complete authored snapshots only. Null/undefined is unavailable; {} is known empty. */
export function projectUsageSessionTimingV1(input: Readonly<{ metadata?: unknown; agentState?: unknown }>): UsageSessionTimingV1 {
    let metadata: UsageTimingBoundsV1 | null = null;
    const parsedMetadata = timingMetadataReadSchema.safeParse(input.metadata);
    if (parsedMetadata.success) {
        const relations = readUsageCollaborationMetadata(parsedMetadata.data);
        const points: (number | null)[] = [];
        if (relations.source) points.push(relations.replayAt);
        if (relations.handoff) points.push(timestamp(relations.handoff.completedAtMs));
        const confirmations = confirmationReadSchema.safeParse(parsedMetadata.data.actionConfirmationsV1);
        const permissions = confirmations.success
            ? permissionTiming(confirmations.data.requests, confirmations.data.completedRequests) : usageTimingBounds([]);
        if (permissions !== null && permissions.minMs !== null) {
            points.push(permissions.minMs);
            if (permissions.maxMs !== null) points.push(permissions.maxMs);
        }
        metadata = permissions === null ? null : usageTimingBounds(points, permissions.minMs !== null && permissions.maxMs === null);
    }
    const parsedState = timingStateReadSchema.safeParse(input.agentState);
    return { v: 1, metadata, agentState: parsedState.success
        ? permissionTiming(parsedState.data.requests ?? {}, parsedState.data.completedRequests ?? {}) : null };
}

/** One opened message certifies only its own hidden times, never retained transcript coverage. */
export function projectUsageSessionMessageTimingV1(input: Readonly<{
    sessionId: string; message: OpenedUsageMessage;
}>): UsageTimingBoundsV1 | null {
    const projection = projectUsageSessionMessageProjection(input.message);
    if (projection.tools.length > 0 && timestamp(projection.createdAt) === null) return null;
    const evidence = projectSessionUsageWorkEvidence({ id: input.sessionId, metadata: null, agentState: null }, undefined,
        { messageProjections: [projection] });
    const points: (number | null)[] = [
        ...(evidence.acceptedInputs ?? []).map(row => row.acceptedAtMs),
        ...(evidence.phaseEvents ?? []).map(row => row.observedAtMs),
        ...(evidence.collaboration ?? []).map(row => row.observedAtMs),
        ...(evidence.coach?.composition ?? []).map(row => row.observedAtMs),
        ...(evidence.coach?.detail?.compactions ?? []).map(row => row.observedAtMs),
        ...(evidence.coach?.detail?.mcpUsage ?? []).flatMap(row => [row.window.startMs, row.observedAtMs]),
    ];
    // A result can precede its paired call in a retained page. Include both authored
    // structured timestamps; the collaboration owner still decides precedence.
    for (const tool of projection.tools) {
        if (projection.createdAt !== undefined) points.push(timestamp(projection.createdAt));
        for (const payload of [tool.input, tool.result]) {
            const structured = projectUsageCollaborationToolPayload(payload);
            if (typeof structured?.runId === 'string' && timestamp(structured.startedAtMs) !== null) {
                points.push(timestamp(structured.startedAtMs));
            }
        }
    }
    return usageTimingBounds(points);
}

type AdmittedUsageTurn = Pick<UsageAccountingSessionMembership['turns'][number], 'sessionId' | 'turnId'>;
type AccountingSessionMembership = ReturnType<typeof readUsageAccountingSessionMembership>;

function resolveAccountingWorkMembership(query: UsageQuery, contributions: readonly UsageAnalyticsContribution[] = [],
    admittedTurns?: readonly AdmittedUsageTurn[], sessionMembership?: AccountingSessionMembership) {
    const selected = query.session === null ? null : new Set(typeof query.session === 'string' ? [query.session] : query.session);
    // Session metadata cannot prove public-population or historical model/source/project membership.
    // Only the canonical scoped accounting contribution can admit those turns.
    const needsAccountingMembership = query.population === 'public_eligible_personal' || query.execution !== undefined
        || query.projects.length > 0 || query.sources.length > 0 || query.modelIds.length > 0
        || query.workspaceIds.length > 0 || query.backendModes.length > 0;
    const matching = contributions.filter(row => row.sessionId !== null
        && (!selected || selected.has(row.sessionId))
        && (!query.agents.length || row.agentId !== null && query.agents.includes(row.agentId))
        && (!query.machines.length || row.machineId !== null && query.machines.includes(row.machineId))
        && (!query.projects.length || row.projectKey !== null && query.projects.includes(row.projectKey))
        && (!query.sources.length || row.source !== null && query.sources.includes(row.source))
        && (query.execution === undefined || (row.sourceContext?.execution ?? 'unknown') === query.execution)
        && (!query.modelIds.length || query.modelIds.some(id =>
            (canonicalUsageModelPriceId(id) ?? 'unknown') === (canonicalUsageModelPriceId(row.modelId) ?? 'unknown')))
        && (!query.workspaceIds.length || row.workspaceId !== null && query.workspaceIds.includes(row.workspaceId))
        && (!query.backendModes.length || row.backendMode != null && query.backendModes.includes(row.backendMode)));
    // Compact accounting already applied the requested historical population
    // and dimensions. Its admitted turns have exactly the same authority as rows.
    const turns = (sessionMembership?.turns ?? admittedTurns)?.filter(turn => !selected || selected.has(turn.sessionId))
        ?? matching.flatMap(row => row.sessionId !== null && row.turnId !== null ? [{ sessionId: row.sessionId, turnId: row.turnId }] : []);
    const accountingWork = new Set(turns.map(turn => JSON.stringify([turn.sessionId, turn.turnId])));
    const accountingSessions = new Set([
        ...(sessionMembership?.sessionIds ?? []),
        ...matching.flatMap(row => row.sessionId === null ? [] : [row.sessionId]),
        ...turns.map(turn => turn.sessionId),
    ].filter(sessionId => !selected || selected.has(sessionId)));
    return { selected, needsAccountingMembership, accountingWork, accountingSessions, matching };
}

/** Read demand and disclosed facts share the same historical membership owner. */
export function usageQueryNeedsSessionCandidates(query: UsageQuery): boolean {
    const membership = resolveAccountingWorkMembership(query);
    return membership.selected === null && !membership.needsAccountingMembership;
}

/** Retained detail is reusable only for the same proved historical Session and turn population. */
export function hasSameUsageQueryWorkEvidenceMembership(input: Readonly<{
    query: UsageQuery;
    contributions?: readonly UsageAnalyticsContribution[];
    previousContributions?: readonly UsageAnalyticsContribution[];
    admittedTurns?: readonly AdmittedUsageTurn[];
    previousAdmittedTurns?: readonly AdmittedUsageTurn[];
    sessionMembership?: AccountingSessionMembership;
    previousSessionMembership?: AccountingSessionMembership;
}>): boolean {
    if (input.contributions === undefined && input.admittedTurns === undefined && input.sessionMembership === undefined
        || input.previousContributions === undefined && input.previousAdmittedTurns === undefined && input.previousSessionMembership === undefined) return false;
    const current = resolveAccountingWorkMembership(input.query, input.contributions, input.admittedTurns, input.sessionMembership);
    const previous = resolveAccountingWorkMembership(input.query, input.previousContributions, input.previousAdmittedTurns, input.previousSessionMembership);
    return current.accountingWork.size === previous.accountingWork.size
        && [...current.accountingWork].every(workId => previous.accountingWork.has(workId))
        && current.accountingSessions.size === previous.accountingSessions.size
        && [...current.accountingSessions].every(sessionId => previous.accountingSessions.has(sessionId));
}

export function selectUsageQueryWorkEvidenceSessionIds(input: Readonly<{
    query: UsageQuery; sessions: readonly Pick<OpenedUsageSession, 'id'>[]; contributions?: readonly UsageAnalyticsContribution[];
    admittedTurns?: readonly AdmittedUsageTurn[];
    sessionMembership?: AccountingSessionMembership;
}>): readonly string[] {
    const membership = resolveAccountingWorkMembership(input.query, input.contributions, input.admittedTurns, input.sessionMembership);
    if (membership.needsAccountingMembership) return [...membership.accountingSessions];
    if (membership.selected) return [...membership.selected];
    return [...new Set([...input.sessions.map(session => session.id),
        ...membership.matching.flatMap(row => row.sessionId === null ? [] : [row.sessionId]), ...membership.accountingSessions])];
}

export function projectUsageQueryWorkEvidence(input: Readonly<{
    query: UsageQuery; sessions: readonly OpenedUsageSession[];
    openedMessages?: ReadonlyMap<string, readonly OpenedUsageMessage[]>;
    sessionEvidence?: ReadonlyMap<string, UsageHowYouWorkDetailInput>;
    completeMessageSessionIds?: ReadonlySet<string>;
    contributions?: readonly UsageAnalyticsContribution[];
    admittedTurns?: readonly AdmittedUsageTurn[];
    sessionMembership?: AccountingSessionMembership;
}>): UsageHowYouWorkDetailInput {
    const unknown = { status: 'unknown' as const };
    const { query } = input;
    const { selected, needsAccountingMembership, accountingWork, accountingSessions } = resolveAccountingWorkMembership(query, input.contributions, input.admittedTurns, input.sessionMembership);
    if (needsAccountingMembership && accountingWork.size === 0) return unknown;
    const sessions = input.sessions.filter(session => (!selected || selected.has(session.id))
        && (!needsAccountingMembership || accountingSessions.has(session.id)));
    const sessionsById = new Map(sessions.map(session => [session.id, session]));
    if (!sessions.length) return unknown;
    const opened = sessions.map(session => input.sessionEvidence?.get(session.id) ?? projectSessionUsageWorkEvidence(session, input.openedMessages?.get(session.id),
        { messagesComplete: input.completeMessageSessionIds?.has(session.id) === true }));
    const facts = opened.flatMap(detail => detail.facts ?? []).filter(fact => accountingWork.has(fact.workId)
        || !needsAccountingMembership && (!query.agents.length || (fact.agentId !== null && query.agents.includes(fact.agentId)))
        && (!query.machines.length || (fact.machineId !== null && query.machines.includes(fact.machineId))));
    const knownWork = new Set([...accountingWork, ...facts.map(fact => fact.workId)]);
    const requiresWorkMembership = needsAccountingMembership || query.agents.length > 0 || query.machines.length > 0;
    const permissions = opened.flatMap(detail => detail.permissions ?? []).filter(fact => !requiresWorkMembership || knownWork.has(fact.workId));
    const closedTurns = opened.flatMap(detail => detail.closedTurns ?? []).filter(fact => !requiresWorkMembership || knownWork.has(fact.workId));
    const collaboration = opened.flatMap(detail => detail.collaboration ?? []).filter(fact => !requiresWorkMembership
        || fact.workId !== null && knownWork.has(fact.workId)).map(fact => resolveUsageCollaborationHistoricalSource(fact,
            fact.sourceSessionId === null ? undefined : sessionsById.get(fact.sourceSessionId),
            needsAccountingMembership ? accountingWork : undefined));
    const acceptedInputs = opened.flatMap(detail => detail.acceptedInputs ?? []).filter(fact => !requiresWorkMembership || knownWork.has(fact.workId));
    const composition = opened.flatMap(detail => detail.coach?.composition ?? []).filter(record =>
        !requiresWorkMembership || record.turnId !== null && knownWork.has(JSON.stringify([record.sessionId, record.turnId])));
    const compactions = opened.flatMap(detail => detail.coach?.detail?.compactions ?? []).filter(record =>
        !requiresWorkMembership || record.turnId !== null && knownWork.has(JSON.stringify([record.sessionId, record.turnId])));
    const modelRequests = opened.flatMap(detail => detail.coach?.detail?.modelRequests ?? []).filter(record =>
        !requiresWorkMembership || knownWork.has(JSON.stringify([record.sessionId, record.turnId])));
    const mcpUsage = opened.flatMap(detail => detail.coach?.detail?.mcpUsage ?? []).filter(record =>
        !requiresWorkMembership || knownWork.has(JSON.stringify([record.sessionId, record.turnId])));
    const phaseEvents = opened.flatMap(detail => detail.phaseEvents ?? []).filter(record =>
        !requiresWorkMembership || record.turnId !== null && knownWork.has(JSON.stringify([record.sessionId, record.turnId])));
    if (opened.every(detail => detail.status === 'unknown')) return unknown;
    return { status: 'partial',
        ...(opened.some(detail => detail.facts !== undefined) ? { facts } : {}),
        ...(opened.some(detail => detail.permissions !== undefined) ? { permissions } : {}),
        ...(opened.some(detail => detail.closedTurns !== undefined) ? { closedTurns } : {}),
        ...(opened.some(detail => detail.collaboration !== undefined) ? { collaboration } : {}),
        ...(opened.some(detail => detail.acceptedInputs !== undefined) ? { acceptedInputs } : {}),
        ...(opened.some(detail => detail.phaseEvents !== undefined) ? { phaseEvents } : {}),
        ...(opened.some(detail => detail.coach !== undefined) ? { coach: { composition, compositionCoverage: 'partial' as const, detail: { coverage: 'partial' as const, compactions, mcpUsage, modelRequests } } } : {}),
        activityAtMs: [...facts.filter(fact => fact.kind === 'busy').map(fact => fact.startMs), ...acceptedInputs.map(fact => fact.acceptedAtMs)] };
}

const timestamp = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Validate the real native record before extracting witnesses; never synthesize a reduced raw record. */
export function projectUsageSessionMessageProjection(message: OpenedUsageMessage): UsageSessionMessageProjection {
    const tools: UsageSessionMessageProjection['tools'][number][] = [];
    const sidechainIds: string[] = [];
    let nativeAgentId: string | null = null;
    let event: TranscriptRawAgentEventV1 | undefined;
    let eventId: string | undefined;
    const content = message.content;
    if (content && typeof content === 'object' && !Array.isArray(content) && 'role' in content
        && content.role === 'agent' && 'content' in content) {
        const record = TranscriptRawAgentRecordV1Schema.safeParse(content.content);
        if (record.success) {
            const raw = record.data;
            nativeAgentId = raw.type === 'output' ? 'claude' : raw.type === 'codex' ? 'codex' : raw.type === 'acp' ? raw.agentId : null;
            if ('sidechainId' in raw.data && typeof raw.data.sidechainId === 'string') sidechainIds.push(raw.data.sidechainId);
            if (raw.type === 'output' && 'parent_tool_use_id' in raw.data && typeof raw.data.parent_tool_use_id === 'string') {
                sidechainIds.push(raw.data.parent_tool_use_id);
            }
            if ((raw.type === 'codex' || raw.type === 'acp') && raw.data.type === 'tool-call'
                && typeof raw.data.callId === 'string' && typeof raw.data.name === 'string') {
                tools.push({ kind: 'call', id: raw.data.callId, name: raw.data.name, input: raw.data.input });
            } else if ((raw.type === 'codex' || raw.type === 'acp') && (raw.data.type === 'tool-result' || raw.data.type === 'tool-call-result')
                && typeof raw.data.callId === 'string') {
                tools.push({ kind: 'result', id: raw.data.callId, name: '', result: raw.data.output });
            } else if (raw.type === 'output' && (raw.data.type === 'assistant' || raw.data.type === 'user')) {
                const assistant = 'message' in raw.data ? raw.data.message : null;
                const blocks = assistant && typeof assistant === 'object' && !Array.isArray(assistant)
                    && 'content' in assistant && Array.isArray(assistant.content) ? assistant.content : [];
                for (const block of blocks) {
                    if (block && typeof block === 'object' && block.type === 'tool_use' && 'id' in block && typeof block.id === 'string'
                        && 'name' in block && typeof block.name === 'string') {
                        tools.push({ kind: 'call', id: block.id, name: block.name, input: 'input' in block ? block.input : undefined });
                    } else if (block && typeof block === 'object' && block.type === 'tool_result' && 'tool_use_id' in block
                        && typeof block.tool_use_id === 'string') {
                        tools.push({ kind: 'result', id: block.tool_use_id, name: '', result: 'content' in block ? block.content : undefined });
                    }
                }
            }
            if (raw.type === 'event') {
                event = raw.data;
                eventId = raw.id;
            } else if (raw.type === 'acp' && raw.data.type === 'event') {
                const parsed = storedEventSchema.safeParse(raw.data.data);
                if (parsed.success) event = parsed.data;
            }
        }
    }
    return { id: message.id, ...(message.localId === undefined ? {} : { localId: message.localId }),
        ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt }),
        ...(message.acceptedDelivery === undefined ? {} : { acceptedDelivery: message.acceptedDelivery }),
        nativeAgentId, sidechainIds, tools, ...(event === undefined ? {} : { event }), ...(eventId === undefined ? {} : { eventId }) };
}

/** A bounded projection of opened canonical facts, never a Session lifecycle owner. */
export function projectSessionUsageWorkEvidence(
    session: OpenedUsageSession,
    messages?: readonly OpenedUsageMessage[],
    coverage: Readonly<{ messagesComplete?: boolean; messageEvidence?: UsageSessionMessageEvidence;
        messageProjections?: readonly UsageSessionMessageProjection[] }> = {},
): UsageHowYouWorkDetailInput {
    const facts: NonNullable<UsageHowYouWorkDetailInput['facts']>[number][] = [];
    const permissions: NonNullable<UsageHowYouWorkDetailInput['permissions']>[number][] = [];
    const turns = session.sessionTurns?.sessionId === session.id ? session.sessionTurns.turns : [];
    const machineId = session.metadata?.machineId ?? null;
    const workId = (turnId: string | null) => JSON.stringify([session.id, turnId]);
    for (const turn of turns) {
        facts.push({ workId: workId(turn.turnId), evidenceId: turn.turnId, agentId: turn.agentId ?? null,
            machineId, kind: 'busy', startMs: turn.startedAt, endMs: timestamp(turn.terminalAt) });
    }
    const state = session.stateEvidence === undefined ? readUsageSessionStateEvidence(session)
        : { known: true, evidence: session.stateEvidence };
    permissions.push(...state.evidence.permissions);
    facts.push(...state.evidence.waits.map(fact => ({ ...fact, machineId })));
    const retained = coverage.messageEvidence;
    const messageProjections = coverage.messageProjections ?? messages?.map(projectUsageSessionMessageProjection);
    const hasMessages = messageProjections !== undefined || retained !== undefined;
    const acceptedInputs = [...(retained?.acceptedInputs ?? [])];
    const seenInputs = new Set<string>();
    const composition = new Map<string, UsagePromptComposition>(retained?.coach?.composition?.map(row => [row.evidenceId, row]));
    const compactions = new Map<string, UsageCoachCompactionFact>(retained?.coach?.detail?.compactions?.map(row => [row.evidenceId, row]));
    const mcpUsage = new Map<string, UsageMcpBindingUsage>(retained?.coach?.detail?.mcpUsage?.map(row => [row.evidenceId, row]));
    const phaseEvents = new Map<string, NonNullable<UsageHowYouWorkDetailInput['phaseEvents']>[number]>(retained?.phaseEvents?.map(row => [row.evidenceId, row]));
    const collaborationTools: UsageCollaborationToolEvidence[] = [];
    const observedSidechainIds = new Set<string>();
    for (const message of messageProjections ?? []) {
        for (const sidechainId of message.sidechainIds) observedSidechainIds.add(sidechainId);
        const observedAtMs = timestamp(message.createdAt);
        for (const tool of message.tools) {
            collaborationTools.push({ id: tool.id, name: tool.name, input: tool.input, result: tool.result,
                observedAtMs, nativeAgentId: message.nativeAgentId });
            if (tool.kind !== 'call' || observedAtMs === null) continue;
            const classification = resolveToolMutationClassification(tool.name);
            const kind = classification === 'read_only' ? 'read' : classification === 'opaque_executor' ? 'execute'
                : classification === 'container' ? 'delegate' : classification === null || classification === 'mutating_unknown'
                    ? 'unknown' : 'change';
            phaseEvents.set(tool.id, { evidenceId: tool.id, sessionId: session.id, turnId: null, observedAtMs,
                kind, method: 'tool_classification' });
        }
        const event = message.event;
        if (event?.type === 'mcp-binding-usage' && event.usage.sessionId === session.id) {
            const usage = event.usage;
            mcpUsage.set(usage.evidenceId, usage);
        }
        if (event?.type === 'prompt-composition' && event.composition.sessionId === session.id) {
            const evidence = event.composition;
            composition.set(evidence.evidenceId, evidence);
        }
        if (event?.type === 'context-compaction') {
            const compaction = event;
            if (compaction.phase === 'completed' && observedAtMs !== null
                && compaction.source !== undefined && compaction.source !== 'transcript-inference' && compaction.source !== 'user-command') {
                const evidenceId = JSON.stringify([session.id, compaction.lifecycleId ?? compaction.agentEventId
                    ?? message.eventId ?? message.localId ?? message.id]);
                compactions.set(evidenceId, { evidenceId, observedAtMs, sessionId: session.id,
                    turnId: compaction.turnId ?? null });
            }
        }
        const accepted = message.acceptedDelivery;
        if (!accepted || !message.localId || seenInputs.has(message.localId)) continue;
        seenInputs.add(message.localId);
        acceptedInputs.push({ inputId: message.localId, workId: workId(accepted.delivery.turnId),
            turnId: accepted.delivery.turnId, acceptedAtMs: accepted.acceptedAtMs, deliveryKind: accepted.delivery.kind });
    }
    const modelRequests: UsageCoachModelRequest[] = [];
    // A complete opened user/event page is necessary to exclude changed workloads.
    // Terminal completion measures response completion, not quality or native context equivalence.
    if (coverage.messagesComplete === true) {
        for (const turn of turns) {
            const terminalAt = timestamp(turn.terminalAt);
            const accepted = acceptedInputs.filter(row => row.turnId === turn.turnId);
            if (turn.status !== 'completed' || terminalAt === null || accepted.length !== 1
                || accepted[0]!.deliveryKind !== 'newTurn') continue;
            const records = [...composition.values()].filter(row => row.inputId === accepted[0]!.inputId);
            if (records.length !== 1) continue;
            const record = records[0]!;
            if (!record.requestIdentity || record.boundary !== 'host_pre_dispatch' || record.deliveryKind !== 'newTurn'
                || record.turnId !== null && record.turnId !== turn.turnId || record.observedAtMs > terminalAt) continue;
            const projected = UsageCoachModelRequestSchema.safeParse({ evidenceId: record.evidenceId,
                observedAtMs: terminalAt, startedAtMs: turn.startedAt, sessionId: session.id,
                turnId: turn.turnId, requestIdentity: record.requestIdentity });
            if (projected.success) modelRequests.push(projected.data);
        }
    }
    // The current retained snapshot/page is not proof of complete historical coverage.
    const hasFacts = session.sessionTurns?.sessionId === session.id || facts.length > 0;
    const hasPermissions = state.known;
    const hasAcceptedInputs = retained?.acceptedInputs !== undefined || messageProjections !== undefined && (messageProjections.length === 0 || acceptedInputs.length > 0);
    const collaboration = projectSessionUsageCollaboration({ session, tools: collaborationTools, observedSidechainIds, retained: retained?.collaboration });
    return { status: hasFacts || hasPermissions || hasMessages || collaboration.length > 0 ? 'partial' : 'unknown',
        ...(hasFacts ? { facts } : {}), ...(hasPermissions ? { permissions } : {}),
        ...(hasFacts ? { closedTurns: turns.map(turn => ({ workId: workId(turn.turnId), agentId: turn.agentId ?? null,
            startMs: turn.startedAt, endMs: timestamp(turn.terminalAt), status: turn.status })) } : {}),
        ...(hasMessages || collaboration.length > 0 ? { collaboration } : {}),
        ...(hasAcceptedInputs ? { acceptedInputs } : {}),
        ...(hasMessages ? { phaseEvents: [...phaseEvents.values()] } : {}),
        ...(hasMessages ? { coach: { composition: [...composition.values()], compositionCoverage: 'partial' as const,
            detail: { coverage: 'partial' as const, compactions: [...compactions.values()], mcpUsage: [...mcpUsage.values()], modelRequests } } } : {}),
        activityAtMs: [...turns.map(turn => turn.startedAt), ...acceptedInputs.map(input => input.acceptedAtMs)] };
}
