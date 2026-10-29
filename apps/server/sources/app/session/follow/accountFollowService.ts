import { AccountSessionFollowV1Schema, OtherAccountFollowV1Schema, EXPLICIT_SESSION_UNFOLLOW_STATE_V1, projectSessionFollowFactsV1, normalizeAccountFollowNotificationChoiceV1, projectAccountFollowNotificationLevelV1, SessionAutoFollowPreferencesV1Schema, type AccountFollowRelationV1, type AccountSessionFollowV1, type OtherAccountFollowV1, type SessionAutoFollowPreferencesV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { SetSessionFollowRequestSchema, SetOtherAccountFollowRequestV1Schema, isOtherAccountFollowMutationSupportedV1,
    ReplaceSessionVoiceInclusionsRequestSchema, type SetSessionFollowRequest, type GetSessionFollowResponse } from '@happier-dev/protocol/sessions/follow/api';
import { compareSessionFollowFrontierProgressV1, encodePersistedSessionFollowFrontierV1, isSessionFollowConsumptionWithinCurrentV1, isSessionFollowFrontierEqualV1, isSessionFollowTurnEqualV1, parsePersistedSessionFollowFrontierV1, projectSessionFollowFrontierFromSourceV1, type SessionFollowFrontierV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { isActiveHomeAccountStatus } from '@happier-dev/protocol/home/governance';
import { pageFollowListV1, readFollowListCursorV1, parseFollowListRequestV1, type FollowListRequestV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowListV1';
import { VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } from '@happier-dev/protocol/sessions/control/contract';

import { resolveEffectiveSessionAccess, resolveStructuralSessionAccessForAccountsInTx } from "@/app/session/access/sessionAccess";
import { backgroundDeliveryAuthentication, type SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import {
    beginViewerReadTrackingOnFollowEntryInTx,
    isSessionPersonallyTrackedInTx,
} from "@/app/session/personal/readState";
import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import { readSnapshotWithCurrentAdmission } from "@/storage/readSnapshotWithCurrentAdmission";
import { markSessionFollowsChangedForAccountsInTx, markSessionFollowsChangedInTx } from "./changes";
import { hasCanonicalFollowProviderInputAcceptanceInTx } from "./providerInputAcceptance";
import { acquireAccountChangePublicationLocksInTx } from "@/app/changes/markAccountChanged";
import { matchesPersonalFollowOnceOccurrenceV1, parsePersistedPersonalFollowOnceV1, projectPersonalFollowCustodyV1, resolveAccountFollowVoiceSelectionV1, type PersonalFollowOnceOccurrenceV1, type PersistedPersonalFollowOnceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { FollowPolicyV1Schema, isFollowPolicyEqualV1, serializeFollowPolicyV1, resolveFollowDeliveryV1, type FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { deriveSessionFollowOriginalOccurrenceKeyV1, resolveExecutionRunFollowOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { FollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { sourceForSessionFollowEdgeV1, sourceKeyForSessionFollowSourceV1 } from './sessionFollowSourceIdentity';
import { canReadFollowSourceInTx } from './followSourceAdmission';
import { resolveDiscussionAudienceInTx } from '@/app/discussions/access';
import { resolveWorkflowRunRecipientAccountIdsInTx } from '@/app/workflows/workflowRunAccess';
import { isExecutionRunFollowFrontierWitnessCurrentInTx, type ExecutionRunFollowFrontierWitness } from './executionRunFollowSource';
import { editFollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/followPolicyEditorV1';
import { isDeliveryMutedInTx, readDeliveryMuteScopesInTx } from './sessionDeliveryMuteService';
import { isFollowDeliveryMutedV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { readAccountFollowCreationPreferencesInTx, updateAccountFollowCreationPreferencesInTx } from './accountFollowCreationPreferences';
import { openSessionFollowListCursor, sealSessionFollowListCursor } from './sessionFollowListCursor';
import { isDeepStrictEqual } from 'node:util';
import { parsePersistedPersonalRunFollowOnceV1, projectPersonalRunFollowCustodyV1, personalRunFollowOnceKeyV1,
    matchesPersonalRunFollowOnceOccurrenceV1, type PersonalRunFollowOnceV1, type PersistedPersonalRunFollowOnceV1,
    type PersonalRunFollowOnceBaselineV1, type PersonalRunFollowOnceOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { resolveEffectiveMachineAccessForMachinesInTx } from '@/app/machines/machineAccess';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

export type CurrentAccountVoiceExecutionRunAuthority = Readonly<{
    executionRunId: string;
    occurrenceId: string;
    parentSessionId: string;
    intent: 'voice_agent';
    runtimeState: 'active_turn' | 'idle';
}>;

async function hasCurrentPrivateAccountVoicePublisherInTx(tx: Tx, input: Readonly<{
    accountId: string;
    voiceSessionId: string;
    runtimeAuthority?: CurrentAccountVoiceExecutionRunAuthority;
}>): Promise<boolean> {
    const authority = input.runtimeAuthority;
    if (!authority
        || !authority.executionRunId.trim()
        || !authority.occurrenceId.trim()
        || authority.intent !== 'voice_agent'
        || authority.parentSessionId !== input.voiceSessionId) return false;
    const voiceSession = await tx.session.findUnique({
        where: { id: input.voiceSessionId },
        select: {
            accountId: true,
            archivedAt: true,
            tag: true,
            shares: { select: { id: true }, take: 1 },
            teamGrants: { select: { sessionId: true }, take: 1 },
            groupGrants: { select: { sessionId: true }, take: 1 },
            publicShare: { select: { sessionId: true } },
        },
    });
    return voiceSession?.accountId === input.accountId
        && voiceSession.archivedAt === null
        && voiceSession.tag === VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG
        && voiceSession.shares.length === 0
        && voiceSession.teamGrants.length === 0
        && voiceSession.groupGrants.length === 0
        && voiceSession.publicShare === null;
}

export type AccountFollowFailure = "invalid_parameters" | "account_inactive" | "session_not_found" | "session_archived"
    | "source_not_found" | "source_unavailable";
export type AccountFollowResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: AccountFollowFailure }>;
const FOLLOW_SELECT = {
    sessionId: true,
    sourceKey: true,
    sourceDiscussionId: true,
    sourceExecutionRunSessionId: true,
    sourceExecutionRunMachineId: true,
    sourceExecutionRunId: true,
    sourceWorkflowRunId: true,
    following: true,
    includeInVoice: true,
    voiceDeliveredFrontier: true,
    followPolicy: true,
    notifyOnce: true,
    hasPersistentFollow: true,
} as const;
const ACCOUNT_SELECT = {
    status: true,
    sessionAutoFollowAssigned: true,
    sessionAutoFollowDirect: true,
    sessionAutoFollowTeam: true,
    sessionAutoFollowGroup: true,
} as const;
type AccountPreferencesRow = Readonly<{
    sessionAutoFollowAssigned: boolean;
    sessionAutoFollowDirect: boolean;
    sessionAutoFollowTeam: boolean;
    sessionAutoFollowGroup: boolean;
}>;
function projectPreferences(row: AccountPreferencesRow): SessionAutoFollowPreferencesV1 {
    return {
        assigned: row.sessionAutoFollowAssigned, direct: row.sessionAutoFollowDirect,
        team: row.sessionAutoFollowTeam, group: row.sessionAutoFollowGroup,
    };
}
export function resolveAccountVoiceSelection(row: Readonly<{ includeInVoice: boolean; followPolicy?: string | null }>): Readonly<{ policy?: FollowPolicyV1 }> | null {
    return resolveAccountFollowVoiceSelectionV1({ includeInVoice: row.includeInVoice, ...projectPersonalFollowCustodyV1(row) });
}

function isVoiceInitialSnapshotPending(row: Readonly<{
    following: boolean;
    includeInVoice: boolean;
    followPolicy?: string | null;
    notifyOnce?: string | null;
    hasPersistentFollow?: boolean;
    voiceDeliveredFrontier: string | null;
}> | null): boolean {
    return row?.following === true && resolveAccountVoiceSelection(row) !== null && row.voiceDeliveredFrontier === null;
}

/** Private Voice custody is selected for pending-state calculation, never exposed as an editable preference. */
function projectAccountSessionFollow(row: Readonly<{
    sessionId: string | null;
    following: boolean;
    includeInVoice: boolean;
    followPolicy?: string | null;
    notifyOnce?: string | null;
    hasPersistentFollow?: boolean;
}>): AccountSessionFollowV1 {
    if (!row.sessionId) throw new Error('Session Follow projection lost its Session source');
    const custody = projectPersonalFollowCustodyV1(row);
    return AccountSessionFollowV1Schema.parse({
        sessionId: row.sessionId,
        following: row.following,
        notificationLevel: row.following ? projectAccountFollowNotificationLevelV1(custody.policy) : 'none',
        includeInVoice: row.following && resolveAccountFollowVoiceSelectionV1({ includeInVoice: row.includeInVoice, ...custody }) !== null,
        ...(row.hasPersistentFollow === false ? { persistent: false } : {}),
        ...custody,
    });
}

type OtherAccountSource = Extract<FollowSourceRefV1, { kind: 'discussion' | 'execution_run' | 'workflow_run' }>;
function sourceFromAccountFollow(row: Readonly<{
    sourceKey: string | null; sessionId: string | null;
    sourceDiscussionId: string | null;
    sourceExecutionRunSessionId: string | null; sourceExecutionRunMachineId: string | null;
    sourceExecutionRunId: string | null; sourceWorkflowRunId: string | null;
}>): OtherAccountSource | null {
    if (!row.sourceKey || row.sessionId !== null) return null;
    const source = sourceForSessionFollowEdgeV1({ ...row, sourceKey: row.sourceKey, sourceSessionId: row.sessionId });
    if (!source || source.kind === 'session') return null;
    if (source.kind === 'discussion' && source.discussionId !== row.sourceDiscussionId) return null;
    if (source.kind !== 'discussion' && row.sourceDiscussionId !== null) return null;
    return source;
}
function projectOtherAccountFollow(row: Readonly<{
    sourceKey: string | null; sessionId: string | null; sourceDiscussionId: string | null;
    sourceExecutionRunSessionId: string | null; sourceExecutionRunMachineId: string | null;
    sourceExecutionRunId: string | null; sourceWorkflowRunId: string | null;
    following: boolean; hasPersistentFollow: boolean; followPolicy: string | null; notifyOnce?: string | null;
}>): OtherAccountFollowV1 | null {
    const source = sourceFromAccountFollow(row);
    if (!source) return null;
    const { policy = { preset: 'custom', events: {} } } = projectPersonalFollowCustodyV1(row);
    return OtherAccountFollowV1Schema.parse({ source, following: row.following,
        persistent: row.hasPersistentFollow, policy, ...projectPersonalRunFollowCustodyV1(row) });
}

/** One private explicit-Follow read for non-Session source adapters. */
export async function readAccountOtherFollowInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication; source: OtherAccountSource;
}>) {
    const source = input.source;
    if (!await activeAccount(tx, input.accountId) || !await canReadFollowSourceInTx(tx, { ...input, source })) return null;
    const sourceKey = sourceKeyForSessionFollowSourceV1(source);
    const row = await tx.accountSessionFollow.findUnique({ where: { accountId_sourceKey: { accountId: input.accountId, sourceKey } },
        select: { ...FOLLOW_SELECT, deliveredDiscussionSeq: true, deliveredExecutionRunTerminalEventId: true,
            deliveredExecutionRunPermissionKey: true, deliveredWorkflowRunRevision: true } });
    if (!row || !row.following && !parsePersistedPersonalRunFollowOnceV1(row.notifyOnce)?.intents.length
        || !isDeepStrictEqual(sourceFromAccountFollow(row), source)) return null;
    const follow = projectOtherAccountFollow(row);
    return follow ? { ...row, sourceKey, policy: follow.policy } : null;
}

/** Own-Account Run delivery uses the same explicit Follow, source admission and mute owners. */
export async function readAccountRunFollowDeliveryInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication;
}> & PersonalRunFollowOnceOccurrenceV1) {
    const source = input.original.source;
    const row = await readAccountOtherFollowInTx(tx, { ...input, source });
    if (!row || await isDeliveryMutedInTx(tx, { accountId: input.accountId, receiver: { kind: 'account' },
        candidate: { source, ...(source.kind === 'execution_run' && 'sessionId' in source ? { senderSessionId: source.sessionId } : {}) } }) !== false) return null;
    // Pick only the admitted occurrence: input also carries private authentication.
    // The input union already proves pairing, which TS loses during reconstruction.
    const occurrence = { original: input.original, event: input.event } as PersonalRunFollowOnceOccurrenceV1;
    const custody = parsePersistedPersonalRunFollowOnceV1(row.notifyOnce);
    const matchingOnce = custody?.intents.some(entry => entry.state === 'armed'
        && matchesPersonalRunFollowOnceOccurrenceV1({ ...entry, occurrence })) === true;
    const fulfilled = custody?.intents.some(entry => entry.state === 'fulfilled'
        && isDeepStrictEqual(entry.occurrence, occurrence)) === true;
    // Output revisions belong to their exact convenience intent; the existing
    // persistent Run policy continues to consume terminal/permission/revision facts.
    const persistentSelected = !('output' in input.original) && row.following && row.hasPersistentFollow
        && resolveFollowDeliveryV1({ policies: [row.policy], event: input.event }).selected;
    if (!persistentSelected && !matchingOnce && !fulfilled) return null;
    const represented = !matchingOnce && (fulfilled || ('terminalEventId' in input.original
        ? row.deliveredExecutionRunTerminalEventId === input.original.terminalEventId
        : 'permissionRequests' in input.original
        ? row.deliveredExecutionRunPermissionKey === deriveSessionFollowOriginalOccurrenceKeyV1(input.original)
        : 'revision' in input.original && (row.deliveredWorkflowRunRevision ?? 0) >= input.original.revision));
    const policy = matchingOnce || fulfilled ? editFollowPolicyV1(row.following ? row.policy : { preset: 'custom', events: {} },
        { kind: 'event', event: input.event, delivery: 'interrupt' }) : row.policy;
    const fulfilledOnce = matchingOnce && custody ? JSON.stringify({ ...custody, intents: custody.intents.map(entry =>
        entry.state === 'armed' && matchesPersonalRunFollowOnceOccurrenceV1({ ...entry, occurrence })
            ? { ...entry, state: 'fulfilled' as const, occurrence } : entry) }) : row.notifyOnce;
    return { sourceKey: row.sourceKey, policy, represented, notifyOnce: row.notifyOnce, fulfilledOnce,
        deliveredExecutionRunTerminalEventId: row.deliveredExecutionRunTerminalEventId,
        deliveredExecutionRunPermissionKey: row.deliveredExecutionRunPermissionKey,
        deliveredWorkflowRunRevision: row.deliveredWorkflowRunRevision };
}
async function activeAccount(tx: Tx, accountId: string) {
    const account = await tx.account.findUnique({ where: { id: accountId }, select: ACCOUNT_SELECT });
    return account && isActiveHomeAccountStatus(account.status) ? account : null;
}
async function readableSession(tx: Tx, input: Readonly<{ accountId: string; sessionId: string; authentication: SessionAccessAuthentication }>) {
    if ((await resolveEffectiveSessionAccess(tx, input))?.capabilities.readTranscript !== true) return null;
    return await tx.session.findUnique({ where: { id: input.sessionId }, select: { accountId: true, archivedAt: true } });
}

/** Source inspection discloses current members anonymously, plus the caller's own membership only. */
export async function readSessionPersonalFollowerCensusInTx(tx: Tx, input: Readonly<{ accountId: string; sessionId: string }>): Promise<{
    peopleCount: number; follows: AccountSessionFollowV1[];
}> {
    const rows = await tx.accountSessionFollow.findMany({ where: { sessionId: input.sessionId }, select: { ...FOLLOW_SELECT, accountId: true } });
    const candidates = rows.filter(row => {
        const facts = projectSessionFollowFactsV1(row);
        return facts.follows || Boolean(facts.once);
    });
    const access = await resolveStructuralSessionAccessForAccountsInTx(tx, { sessionId: input.sessionId,
        accountIds: candidates.map(row => row.accountId) });
    const members = candidates.filter(row => access.get(row.accountId)?.capabilities.readTranscript === true);
    const own = members.find(row => row.accountId === input.accountId);
    return { peopleCount: members.length, follows: own ? [projectAccountSessionFollow(own)] : [] };
}

/** Reverse generic inspection counts only current source recipients, never reveals their identities. */
export async function readOtherPersonalFollowerCensusInTx(tx: Tx, input: Readonly<{
    accountId: string; source: OtherAccountSource;
}>): Promise<Readonly<{ peopleCount: number; follows: OtherAccountFollowV1[] }>> {
    const rows = await tx.accountSessionFollow.findMany({ where: {
        sourceKey: sourceKeyForSessionFollowSourceV1(input.source), OR: [{ following: true }, { notifyOnce: { not: null } }],
    }, select: { ...FOLLOW_SELECT, accountId: true } });
    const candidates = rows.flatMap(row => {
        if (!isDeepStrictEqual(sourceFromAccountFollow(row), input.source))
            throw new Error('Account Follow Run source digest collision');
        const follow = projectOtherAccountFollow(row);
        return follow && (follow.following || follow.once?.length) ? [{ accountId: row.accountId, follow }] : [];
    });
    if (candidates.length === 0) return { peopleCount: 0, follows: [] };
    let audience: ReadonlySet<string>;
    if (input.source.kind === 'discussion') {
        audience = new Set(await resolveDiscussionAudienceInTx(tx, input.source.discussionId));
    } else if (input.source.kind === 'workflow_run') {
        audience = new Set(await resolveWorkflowRunRecipientAccountIdsInTx(tx, input.source.runId));
    } else if ('sessionId' in input.source) {
        const access = await resolveStructuralSessionAccessForAccountsInTx(tx, {
            sessionId: input.source.sessionId, accountIds: candidates.map(row => row.accountId),
        });
        audience = new Set(candidates.filter(row => access.get(row.accountId)?.capabilities.readTranscript === true)
            .map(row => row.accountId));
    } else {
        const access = (await resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds: [input.source.machineId],
            accountIds: candidates.map(row => row.accountId), rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER }))
            .get(input.source.machineId);
        audience = new Set(candidates.filter(row => access?.get(row.accountId) != null).map(row => row.accountId));
    }
    const members = candidates.filter(row => audience.has(row.accountId));
    return { peopleCount: members.length,
        follows: members.filter(row => row.accountId === input.accountId).map(row => row.follow) };
}

/** Lists private choices and accepted one-shot refs through current source read admission. */
export async function listAccountSessionFollows(input: Readonly<{ accountId: string; authentication: SessionAccessAuthentication }> & FollowListRequestV1): Promise<AccountFollowResult<{ follows: AccountFollowRelationV1[]; continuation?: string }>> {
    let selection: FollowListRequestV1, scope: string, after: string | undefined;
    try {
        selection = parseFollowListRequestV1({ cursor: input.cursor, limit: input.limit, source: input.source, sourceKinds: input.sourceKinds });
        scope = JSON.stringify([input.accountId, 'following', ...(selection.source ? [selection.source] : []),
            ...(selection.sourceKinds ? [{ sourceKinds: selection.sourceKinds }] : [])]);
        selection = { ...selection, cursor: openSessionFollowListCursor(scope, selection.cursor) };
        after = readFollowListCursorV1(scope, selection.cursor);
    } catch { return { ok: false, error: 'invalid_parameters' }; }
    const source = selection.source;
    if (source?.kind === 'rule') return { ok: false, error: 'invalid_parameters' };
    const sourceWhere = !source ? {} : source.kind === 'session'
        ? { OR: [{ sessionId: source.sessionId }, { sourceExecutionRunSessionId: source.sessionId }] }
        : { sourceKey: sourceKeyForSessionFollowSourceV1(source) };
    const kindsWhere = selection.sourceKinds === undefined ? {} : { OR: selection.sourceKinds.map(kind => kind === 'session'
        ? { sessionId: { not: null } } : { sourceKey: { startsWith: `${kind}:` } }) };
    return readSnapshotWithCurrentAdmission<AccountFollowResult<{ follows: AccountFollowRelationV1[]; continuation?: string }>>(async tx => {
        if (!await activeAccount(tx, input.accountId)) return { ok: false as const, error: 'account_inactive' as const };
        const where = { accountId: input.accountId, AND: [{ OR: [{ following: true }, { notifyOnce: { not: null } }] }, sourceWhere, kindsWhere] };
        // Session-only retained rows may have a null key. Page both disjoint SQL
        // partitions before admission, then merge by the same canonical cursor key.
        const take: { take?: number } = selection.limit === undefined ? {} : { take: selection.limit + 1 };
        const keyed = await tx.accountSessionFollow.findMany({ where: { AND: [where,
            { sourceKey: after === undefined ? { not: null } : { gt: after } }] }, select: FOLLOW_SELECT,
            orderBy: { sourceKey: 'asc' }, ...take });
        const includeUnkeyed = (selection.sourceKinds === undefined || selection.sourceKinds.includes('session'))
            && (after === undefined || after < 'session:' || after.startsWith('session:'));
        const unkeyed = includeUnkeyed ? await tx.accountSessionFollow.findMany({ where: { AND: [where,
            { sourceKey: null, sessionId: after?.startsWith('session:') ? { gt: after.slice('session:'.length) } : { not: null } }] },
            select: FOLLOW_SELECT, orderBy: { sessionId: 'asc' }, ...take }) : [];
        const page = pageFollowListV1({ scope, rows: [...keyed, ...unkeyed],
            key: row => row.sourceKey ?? sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: row.sessionId! }),
            cursor: selection.cursor, limit: selection.limit });
        const follows: AccountFollowRelationV1[] = [];
        for (const row of page.rows) {
            if (row.sessionId) {
                const follow = projectAccountSessionFollow(row);
                if ((follow.following || follow.once || follow.onceDelivery)
                    && await readableSession(tx, { ...input, sessionId: row.sessionId })) follows.push(follow);
            } else {
                const source = sourceFromAccountFollow(row);
                if (!source || !await canReadFollowSourceInTx(tx, { ...input, source })) continue;
                const projected = projectOtherAccountFollow(row);
                if (projected && (projected.following || projected.once?.length || projected.onceDeliveries?.length)) follows.push(projected);
            }
        }
        return { ok: true as const, value: { follows, ...(page.continuation ? { continuation: page.continuation } : {}) } };
    }, async (tx, captured) => {
        if (!captured.ok) return captured;
        if (!await activeAccount(tx, input.accountId)) return { ok: false as const, error: 'account_inactive' as const };
        const follows: AccountFollowRelationV1[] = [];
        for (const row of captured.value.follows) {
            if ('sessionId' in row) {
                if (await readableSession(tx, { ...input, sessionId: row.sessionId })) follows.push(row);
            } else if (row.source.kind !== 'rule' && await canReadFollowSourceInTx(tx, { ...input, source: row.source })) follows.push(row);
        }
        return { ok: true as const, value: { follows, ...(captured.value.continuation
            ? { continuation: sealSessionFollowListCursor(scope, captured.value.continuation) } : {}) } };
    });
}

/** Exact non-Session personal choice; source grant is read from its current owner. */
export async function getOtherAccountFollow(input: Readonly<{
    accountId: string; source: OtherAccountSource; authentication: SessionAccessAuthentication;
}>): Promise<AccountFollowResult<Readonly<{ follow: OtherAccountFollowV1 | null }>>> {
    return readSnapshotWithCurrentAdmission(async tx => {
        if (!await activeAccount(tx, input.accountId)) return { ok: false as const, error: 'account_inactive' as const };
        if (!await canReadFollowSourceInTx(tx, input)) return { ok: false as const, error: 'source_not_found' as const };
        const row = await tx.accountSessionFollow.findUnique({ where: { accountId_sourceKey: {
            accountId: input.accountId, sourceKey: sourceKeyForSessionFollowSourceV1(input.source),
        } }, select: FOLLOW_SELECT });
        if (row && !isDeepStrictEqual(sourceFromAccountFollow(row), input.source))
            throw new Error('Account Follow Run source digest collision');
        return { ok: true as const, value: { follow: row ? projectOtherAccountFollow(row) : null } };
    }, async (tx, captured) => {
        if (!captured.ok) return captured;
        if (!await activeAccount(tx, input.accountId)) return { ok: false as const, error: 'account_inactive' as const };
        return await canReadFollowSourceInTx(tx, input) ? captured : { ok: false as const, error: 'source_not_found' as const };
    });
}

/** Personal policy uses this AccountSessionFollow row, including suppression and source baselines. */
export async function setOtherAccountFollow(input: Readonly<{
    accountId: string; source: OtherAccountSource; policy?: FollowPolicyV1; once?: PersonalRunFollowOnceV1[] | null;
    clearOnceDeliveries?: true;
    authentication: SessionAccessAuthentication;
    executionRunFrontier?: ExecutionRunFollowFrontierWitness;
}>): Promise<AccountFollowResult<Readonly<{ changed: boolean; follow: OtherAccountFollowV1 }>>> {
    const parsed = SetOtherAccountFollowRequestV1Schema.safeParse({ policy: input.policy, once: input.once,
        clearOnceDeliveries: input.clearOnceDeliveries });
    if (!parsed.success || !isOtherAccountFollowMutationSupportedV1(input.source, parsed.data))
        return { ok: false, error: 'invalid_parameters' };
    const preferences = parsed.data;
    return inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: 'account_inactive' };
        if (!await canReadFollowSourceInTx(tx, input)) return { ok: false, error: 'source_not_found' };
        if (input.source.kind === 'discussion') {
            const discussion = await tx.discussion.findUnique({ where: { id: input.source.discussionId }, select: { archivedAt: true } });
            if (!discussion) return { ok: false, error: 'source_not_found' };
            if (discussion.archivedAt !== null) return { ok: false, error: 'session_archived' };
        }
        if (input.source.kind === 'execution_run' && 'sessionId' in input.source) {
            const session = await tx.session.findUnique({ where: { id: input.source.sessionId }, select: { archivedAt: true } });
            if (!session) return { ok: false, error: 'source_not_found' };
            if (session.archivedAt !== null) return { ok: false, error: 'session_archived' };
        }
        const sourceKey = sourceKeyForSessionFollowSourceV1(input.source);
        const key = { accountId: input.accountId, sourceKey };
        const existing = await tx.accountSessionFollow.findUnique({ where: { accountId_sourceKey: key }, select: FOLLOW_SELECT });
        if (existing && !isDeepStrictEqual(sourceFromAccountFollow(existing), input.source))
            throw new Error('Account Follow Run source digest collision');
        const reseed = input.policy !== undefined && (!existing || !existing.following);
        const previousOnce = parsePersistedPersonalRunFollowOnceV1(existing?.notifyOnce);
        const requestedOnce = preferences.once === undefined
            ? previousOnce?.intents.flatMap(entry => entry.state === 'armed' ? [entry.once] : []) ?? []
            : preferences.once ?? [];
        const newlyArmed = requestedOnce.filter(intent => !previousOnce?.intents.some(entry => entry.state === 'armed'
            && isDeepStrictEqual(entry.once, intent)));
        if ((reseed || newlyArmed.length > 0) && input.source.kind === 'execution_run') {
            const frontier = input.executionRunFrontier;
            if (!frontier || !isDeepStrictEqual(frontier.source, input.source)
                || !await isExecutionRunFollowFrontierWitnessCurrentInTx(tx, frontier))
                return { ok: false, error: 'source_unavailable' };
        }
        const persistentMutation = preferences.policy !== undefined;
        const followPolicy = preferences.policy ? serializeFollowPolicyV1(preferences.policy) : existing?.followPolicy ?? null;
        const following = persistentMutation || existing?.following === true;
        const hasPersistentFollow = persistentMutation || existing?.hasPersistentFollow === true;
        const raw = input.source.kind === 'discussion' ? { sourceDiscussionId: input.source.discussionId }
            : input.source.kind === 'workflow_run' ? { sourceWorkflowRunId: input.source.runId }
            : { sourceExecutionRunSessionId: 'sessionId' in input.source ? input.source.sessionId : null,
                sourceExecutionRunMachineId: 'machineId' in input.source ? input.source.machineId : null,
                sourceExecutionRunId: input.source.runId };
        const runFrontier = input.source.kind === 'execution_run' ? input.executionRunFrontier : undefined;
        const runOccurrence = runFrontier ? resolveExecutionRunFollowOccurrenceV1({ ...runFrontier,
            sessionId: 'sessionId' in runFrontier.source ? runFrontier.source.sessionId : null,
            ...('machineId' in runFrontier.source ? { machineId: runFrontier.source.machineId } : {}),
            runId: runFrontier.source.runId }) : null;
        const workflowRevision = input.source.kind === 'workflow_run' && (reseed || newlyArmed.length > 0)
            ? (await tx.automationRun.findUniqueOrThrow({ where: { id: input.source.runId }, select: { revision: true } })).revision : null;
        let notifyOnce = existing?.notifyOnce ?? null;
        if (preferences.once !== undefined || preferences.clearOnceDeliveries) {
            const intents: PersistedPersonalRunFollowOnceV1['intents'] = [];
            for (const intent of requestedOnce) {
                const retained = previousOnce?.intents.find(entry => entry.state === 'armed' && isDeepStrictEqual(entry.once, intent));
                if (retained) { intents.push(retained); continue; }
                const baseline: PersonalRunFollowOnceBaselineV1 = { original: input.source.kind === 'workflow_run'
                    && workflowRevision !== null && workflowRevision > 0 ? { source: input.source, revision: workflowRevision }
                    : runOccurrence?.original ?? null };
                if (intent.kind === 'output_ready') {
                    const output = runFrontier?.outputs?.find(output => isDeepStrictEqual(output.outputRef, intent.outputRef));
                    if (!output) return { ok: false, error: 'source_unavailable' };
                    if (intent.afterRevision !== undefined) baseline.outputRevision = intent.afterRevision;
                    else if (output.state === 'pending' || output.state === 'writing') baseline.outputRevision = output.revision;
                }
                intents.push({ state: 'armed', once: intent, baseline });
            }
            // Editing another control is not reading its accepted result.
            // Re-arming the same exact control deliberately replaces that receipt.
            if (preferences.once !== null && !preferences.clearOnceDeliveries) {
                const requestedKeys = new Set(requestedOnce.map(personalRunFollowOnceKeyV1));
                intents.push(...previousOnce?.intents.filter(entry => entry.state === 'fulfilled'
                    && !requestedKeys.has(personalRunFollowOnceKeyV1(entry.once))) ?? []);
            }
            notifyOnce = intents.length ? JSON.stringify({ v: 1, intents } satisfies PersistedPersonalRunFollowOnceV1) : null;
        }
        if (existing && existing.following === following && existing.hasPersistentFollow === hasPersistentFollow
            && existing.followPolicy === followPolicy && existing.notifyOnce === notifyOnce) {
            const follow = projectOtherAccountFollow(existing);
            if (!follow) return { ok: false, error: 'source_unavailable' };
            return { ok: true, value: { changed: false, follow } };
        }
        const baseline = !reseed ? {} : input.source.kind === 'discussion'
            ? { deliveredDiscussionSeq: (await tx.discussion.findUniqueOrThrow({ where: { id: input.source.discussionId },
                select: { messageSeq: true } })).messageSeq }
            : input.source.kind === 'workflow_run'
                ? { deliveredWorkflowRunRevision: workflowRevision }
                : { deliveredExecutionRunTerminalEventId: input.executionRunFrontier?.terminalEventId ?? null,
                    deliveredExecutionRunPermissionKey: runOccurrence && 'permissionRequests' in runOccurrence.original
                        ? deriveSessionFollowOriginalOccurrenceKeyV1(runOccurrence.original) : null };
        const row = await tx.accountSessionFollow.upsert({ where: { accountId_sourceKey: key },
            create: { accountId: input.accountId, sourceKey, ...raw, ...baseline,
                following, hasPersistentFollow, notifyOnce,
                includeInVoice: false, followPolicy },
            update: { following, hasPersistentFollow, notifyOnce, followPolicy,
                ...(persistentMutation ? { includeInVoice: false } : {}), ...baseline },
            select: FOLLOW_SELECT });
        if (!isDeepStrictEqual(sourceFromAccountFollow(row), input.source))
            throw new Error('Account Follow Run source digest collision');
        const follow = projectOtherAccountFollow(row);
        if (!follow) throw new Error('Account Follow source update lost exact identity');
        await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        return { ok: true, value: { changed: true, follow } };
    });
}

/** Explicit generic Unfollow suppresses future effects without requiring a now-lost source grant. */
export async function removeOtherAccountFollow(input: Readonly<{
    accountId: string; source: OtherAccountSource; authentication: SessionAccessAuthentication;
}>): Promise<AccountFollowResult<Readonly<{ changed: boolean }>>> {
    return inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: 'account_inactive' };
        const key = { accountId: input.accountId, sourceKey: sourceKeyForSessionFollowSourceV1(input.source) };
        const existing = await tx.accountSessionFollow.findUnique({ where: { accountId_sourceKey: key }, select: FOLLOW_SELECT });
        if (existing && !isDeepStrictEqual(sourceFromAccountFollow(existing), input.source))
            throw new Error('Account Follow Run source digest collision');
        if (!existing && !await canReadFollowSourceInTx(tx, input)) return { ok: false, error: 'source_not_found' };
        if (existing?.following === false && existing.hasPersistentFollow && existing.notifyOnce === null)
            return { ok: true, value: { changed: false } };
        const raw = input.source.kind === 'discussion' ? { sourceDiscussionId: input.source.discussionId }
            : input.source.kind === 'workflow_run' ? { sourceWorkflowRunId: input.source.runId }
            : { sourceExecutionRunSessionId: 'sessionId' in input.source ? input.source.sessionId : null,
                sourceExecutionRunMachineId: 'machineId' in input.source ? input.source.machineId : null,
                sourceExecutionRunId: input.source.runId };
        await tx.accountSessionFollow.upsert({ where: { accountId_sourceKey: key },
            create: { ...key, ...raw, following: false, hasPersistentFollow: true,
                includeInVoice: false, followPolicy: serializeFollowPolicyV1({ preset: 'quiet' }), notifyOnce: null },
            update: { following: false, hasPersistentFollow: true,
                includeInVoice: false, followPolicy: serializeFollowPolicyV1({ preset: 'quiet' }), notifyOnce: null } });
        await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        return { ok: true, value: { changed: true } };
    });
}

/** Reads only the authenticated Account's personal choice after current Session read admission. */
export async function getAccountSessionFollow(input: Readonly<{ accountId: string; sessionId: string; authentication: SessionAccessAuthentication }>): Promise<AccountFollowResult<GetSessionFollowResponse>> {
    return await readSnapshotWithCurrentAdmission<AccountFollowResult<GetSessionFollowResponse>>(async tx => {
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const session = await readableSession(tx, input);
        if (!session) return { ok: false, error: "session_not_found" };
        const key = { accountId: input.accountId, sessionId: input.sessionId };
        const row = await tx.accountSessionFollow.findUnique({ where: { accountId_sessionId: key }, select: FOLLOW_SELECT });
        return { ok: true, value: {
            follow: row ? projectAccountSessionFollow(row) : null,
            isSessionOwner: session.accountId === input.accountId,
            capabilities: { manageFollow: true },
            voiceInitialSnapshotPending: isVoiceInitialSnapshotPending(row),
        } };
    }, async (tx, captured) => {
        if (!captured.ok) return captured;
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        return await readableSession(tx, input) ? captured : { ok: false, error: "session_not_found" };
    });
}

/** Replaces a personal Follow choice and seeds newly entered tracking through its canonical owner. */
export async function setAccountSessionFollow(input: Readonly<{
    accountId: string; sessionId: string; preferences: SetSessionFollowRequest;
    authentication: SessionAccessAuthentication;
}>): Promise<AccountFollowResult<Readonly<{
    changed: boolean;
    follow: AccountSessionFollowV1;
    voiceInitialSnapshotPending: boolean;
}>>> {
    const parsed = SetSessionFollowRequestSchema.safeParse(input.preferences);
    if (!parsed.success) return { ok: false, error: "invalid_parameters" };
    const preferences = parsed.data;
    return await inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const session = await readableSession(tx, input);
        if (!session) return { ok: false, error: "session_not_found" };
        if (session.archivedAt !== null) return { ok: false, error: "session_archived" };
        const key = { accountId: input.accountId, sessionId: input.sessionId };
        const existing = await tx.accountSessionFollow.findUnique({ where: { accountId_sessionId: key }, select: FOLLOW_SELECT });
        const persistentMutation = preferences.policy !== undefined || preferences.notificationLevel !== undefined;
        // Scalar edits are ingress only; persistence has one policy authority.
        const policyWrite = preferences.policy !== undefined ? { followPolicy: JSON.stringify(preferences.policy) }
            : preferences.notificationLevel !== undefined ? { followPolicy: serializeFollowPolicyV1(normalizeAccountFollowNotificationChoiceV1({
                notificationLevel: preferences.notificationLevel, includeInVoice: preferences.includeInVoice === true,
            })) } : {};
        let notifyOnce = existing?.notifyOnce ?? null;
        if (preferences.once !== undefined) {
            if (preferences.once === null) notifyOnce = null;
            else {
                const source = await tx.session.findUniqueOrThrow({ where: { id: input.sessionId }, select: {
                    seq: true, latestReadyEventSeq: true, agentStateVersion: true, latestTurnId: true, latestTurnStatus: true,
                } });
                if (preferences.once.kind === 'turn_finished'
                    && (source.latestTurnId !== preferences.once.sourceTurnId || source.latestTurnStatus !== 'in_progress')) {
                    return { ok: false, error: 'invalid_parameters' };
                }
                const armed: PersistedPersonalFollowOnceV1 = { v: 1, state: 'armed', once: preferences.once,
                    baseline: projectSessionFollowFrontierFromSourceV1(source) };
                // Retrying an unchanged intent does not move its needs-you baseline.
                const previous = parsePersistedPersonalFollowOnceV1(existing?.notifyOnce);
                notifyOnce = previous?.state === 'armed' && JSON.stringify(previous.once) === JSON.stringify(preferences.once)
                    ? existing!.notifyOnce : JSON.stringify(armed);
            }
        }
        const includeInVoice = persistentMutation ? false : existing?.includeInVoice ?? false;
        const following = persistentMutation ? true : existing?.following ?? false;
        const hasPersistentFollow = persistentMutation || existing?.hasPersistentFollow === true;
        const followPolicy = 'followPolicy' in policyWrite ? policyWrite.followPolicy : existing?.followPolicy ?? null;
        if (existing && existing.following === following
            && existing.includeInVoice === includeInVoice && existing.followPolicy === followPolicy && existing.notifyOnce === notifyOnce
            && existing.hasPersistentFollow === hasPersistentFollow) {
            return { ok: true, value: {
                changed: false,
                follow: projectAccountSessionFollow(existing),
                voiceInitialSnapshotPending: isVoiceInitialSnapshotPending(existing),
            } };
        }
        const wasTracked = await isSessionPersonallyTrackedInTx(tx, { ...key, ownerAccountId: session.accountId });
        const voiceSelected = resolveAccountVoiceSelection({ includeInVoice, followPolicy }) !== null;
        const previouslySelected = existing !== null && resolveAccountVoiceSelection(existing) !== null;
        const row = await tx.accountSessionFollow.upsert({
            where: { accountId_sessionId: key },
            create: { ...key, following, hasPersistentFollow, includeInVoice, followPolicy, notifyOnce, voiceDeliveredFrontier: null },
            update: { following, hasPersistentFollow, includeInVoice, followPolicy, notifyOnce,
                ...(!voiceSelected || !previouslySelected
                    ? { voiceDeliveredFrontier: null } : {}) },
            select: FOLLOW_SELECT,
        });
        if (persistentMutation) await beginViewerReadTrackingOnFollowEntryInTx({ tx, ...key, wasTracked, authentication: input.authentication });
        await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        return { ok: true, value: {
            changed: true,
            follow: projectAccountSessionFollow(row),
            voiceInitialSnapshotPending: isVoiceInitialSnapshotPending(row),
        } };
    });
}

/** Explicit Unfollow persists suppression, including after visibility loss, without disclosing a Session. */
export async function removeAccountSessionFollow(input: Readonly<{ accountId: string; sessionId: string; authentication: SessionAccessAuthentication }>): Promise<AccountFollowResult<Readonly<{ changed: boolean }>>> {
    return await inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const key = { accountId: input.accountId, sessionId: input.sessionId };
        const existing = await tx.accountSessionFollow.findUnique({ where: { accountId_sessionId: key }, select: FOLLOW_SELECT });
        if (!existing && !await readableSession(tx, input)) return { ok: false, error: "session_not_found" };
        if (existing && existing.hasPersistentFollow && !existing.following && existing.notifyOnce === null) return { ok: true, value: { changed: false } };
        const { notificationLevel: _notificationLevel, ...unfollowState } = EXPLICIT_SESSION_UNFOLLOW_STATE_V1;
        const suppressed = { ...unfollowState, hasPersistentFollow: true, followPolicy: null, notifyOnce: null, voiceDeliveredFrontier: null };
        await tx.accountSessionFollow.upsert({ where: { accountId_sessionId: key }, create: { ...key, ...suppressed }, update: suppressed });
        await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        return { ok: true, value: { changed: true } };
    });
}

/**
 * Settles an accepted personal effect against the exact armed intent. The
 * fulfilled source reference keeps that one Inbox item available without
 * changing persistent interest, suppression, Voice or private read state.
 */
export async function consumeAccountSessionFollowOnceInTx(tx: Tx, input: Readonly<{
    accountId: string;
    sessionId: string;
    expectedOnce: string;
    accepted: boolean;
    occurrence: PersonalFollowOnceOccurrenceV1;
}>): Promise<boolean> {
    if (!input.accepted) return false;
    const armed = parsePersistedPersonalFollowOnceV1(input.expectedOnce);
    if (armed?.state !== 'armed' || !matchesPersonalFollowOnceOccurrenceV1({ ...armed, occurrence: input.occurrence })) return false;
    const changed = await tx.accountSessionFollow.updateMany({
        where: { accountId: input.accountId, sessionId: input.sessionId, notifyOnce: input.expectedOnce },
        data: { notifyOnce: JSON.stringify({ ...armed, state: 'fulfilled', occurrence: input.occurrence } satisfies PersistedPersonalFollowOnceV1) },
    });
    if (changed.count !== 1) return false;
    await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
    return true;
}

/** Accepts one source-backed Inbox reference after fresh background admission. */
export async function acceptAccountSessionFollowOnceDelivery(input: Readonly<{
    accountId: string; sessionId: string; expectedOnce: string; occurrence: PersonalFollowOnceOccurrenceV1;
}>): Promise<boolean> {
    return inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
        if (!await activeAccount(tx, input.accountId)) return false;
        const session = await readableSession(tx, { ...input, authentication: backgroundDeliveryAuthentication() });
        if (!session || session.archivedAt !== null) return false;
        if (await isDeliveryMutedInTx(tx, {
            receiver: { kind: 'account' }, accountId: input.accountId,
            candidate: { senderSessionId: input.sessionId, source: { kind: 'session', sessionId: input.sessionId } },
        }) !== false) return false;
        return acceptAccountSessionFollowOnceDeliveryInTx(tx, input);
    });
}

/** Caller owns recipient admission and Account publication locks in this transaction. */
export async function acceptAccountSessionFollowOnceDeliveryInTx(tx: Tx, input: Readonly<{
    accountId: string; sessionId: string; expectedOnce: string; occurrence: PersonalFollowOnceOccurrenceV1;
}>): Promise<boolean> {
    const event = input.occurrence.event;
    if (event === 'permission_required' || event === 'user_action_required') {
        // A later encrypted state cannot prove the original request is live.
        const source = await tx.session.findUnique({ where: { id: input.sessionId }, select: { agentStateVersion: true } });
        if (source?.agentStateVersion !== input.occurrence.agentStateVersion) return false;
    } else {
        if (!input.occurrence.turnId || event !== 'ready' && event !== 'failed' && event !== 'cancelled') return false;
        const turn = await tx.sessionTurn.findUnique({ where: { sessionId_turnId: {
            sessionId: input.sessionId, turnId: input.occurrence.turnId,
        } }, select: { status: true } });
        if (turn?.status !== (event === 'ready' ? 'completed' : event)) return false;
    }
    return consumeAccountSessionFollowOnceInTx(tx, { ...input, accepted: true });
}

/** Existing explicit mark-read/settle clears accepted convenience attention only. */
export async function clearFulfilledAccountSessionFollowOnceInTx(tx: Tx, input: Readonly<{
    accountId: string; sessionId: string;
}>): Promise<boolean> {
    const row = await tx.accountSessionFollow.findUnique({ where: { accountId_sessionId: input }, select: { notifyOnce: true } });
    if (parsePersistedPersonalFollowOnceV1(row?.notifyOnce)?.state !== 'fulfilled') return false;
    const result = await tx.accountSessionFollow.updateMany({ where: { ...input, notifyOnce: row!.notifyOnce }, data: { notifyOnce: null } });
    if (result.count !== 1) return false;
    await markSessionFollowsChangedInTx(tx, input);
    return true;
}

/** Atomically replaces one Home's durable Include in Voice membership. */
export async function replaceAccountSessionVoiceInclusions(input: Readonly<{
    accountId: string;
    sessionIds: readonly string[];
    authentication: SessionAccessAuthentication;
}>): Promise<AccountFollowResult<Readonly<{ changed: boolean; sessionIds: string[] }>>> {
    const parsed = ReplaceSessionVoiceInclusionsRequestSchema.safeParse({ sessionIds: input.sessionIds });
    if (!parsed.success) return { ok: false, error: "invalid_parameters" };
    const sessionIds = [...new Set(parsed.data.sessionIds)].sort();
    return await inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const sessions = new Map<string, Readonly<{ accountId: string; archivedAt: Date | null }>>();
        for (const sessionId of sessionIds) {
            const session = await readableSession(tx, { ...input, sessionId });
            if (!session) return { ok: false, error: "session_not_found" };
            if (session.archivedAt !== null) return { ok: false, error: "session_archived" };
            sessions.set(sessionId, session);
        }
        const desired = new Set(sessionIds);
        const existing = (await tx.accountSessionFollow.findMany({
            where: { accountId: input.accountId, sessionId: { not: null } },
            select: FOLLOW_SELECT,
        })).filter((row): row is typeof row & { sessionId: string } => row.sessionId !== null);
        const existingBySessionId = new Map(existing.map(row => [row.sessionId, row] as const));
        let changed = false;
        for (const row of existing) {
            if (!row.following || desired.has(row.sessionId)) continue;
            if (resolveAccountVoiceSelection(row) === null && !row.includeInVoice) continue;
            const policy = projectPersonalFollowCustodyV1(row).policy;
            await tx.accountSessionFollow.update({
                where: { accountId_sessionId: { accountId: input.accountId, sessionId: row.sessionId } },
                data: { includeInVoice: false, voiceDeliveredFrontier: null,
                    ...(policy ? { followPolicy: JSON.stringify(editFollowPolicyV1(policy, { kind: 'voice', enabled: false })) } : {}) },
            });
            changed = true;
        }
        for (const sessionId of sessionIds) {
            const key = { accountId: input.accountId, sessionId };
            const row = existingBySessionId.get(sessionId);
            if (row?.following && resolveAccountVoiceSelection(row) !== null) continue;
            const policy = row?.following ? projectPersonalFollowCustodyV1(row).policy : undefined;
            const voicePolicy = policy ? editFollowPolicyV1(policy, { kind: 'voice', enabled: true })
                : normalizeAccountFollowNotificationChoiceV1({ notificationLevel: 'none', includeInVoice: true });
            if (row?.following && !row.includeInVoice && policy && voicePolicy && isFollowPolicyEqualV1(policy, voicePolicy)) continue;
            const session = sessions.get(sessionId)!;
            const wasTracked = await isSessionPersonallyTrackedInTx(tx, { ...key, ownerAccountId: session.accountId });
            await tx.accountSessionFollow.upsert({
                where: { accountId_sessionId: key },
                create: { ...key, following: true, includeInVoice: false, followPolicy: serializeFollowPolicyV1(voicePolicy), voiceDeliveredFrontier: null },
                update: {
                    following: true,
                    hasPersistentFollow: true,
                    includeInVoice: false,
                    followPolicy: serializeFollowPolicyV1(voicePolicy),
                    voiceDeliveredFrontier: null,
                },
            });
            await beginViewerReadTrackingOnFollowEntryInTx({ tx, ...key, wasTracked, authentication: input.authentication });
            changed = true;
        }
        if (changed) await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        const effective = await tx.accountSessionFollow.findMany({ where: { accountId: input.accountId, following: true, sessionId: { not: null } },
            select: { sessionId: true, includeInVoice: true, followPolicy: true }, orderBy: { sessionId: 'asc' } });
        return { ok: true, value: { changed, sessionIds: effective.flatMap(row => row.sessionId !== null && resolveAccountVoiceSelection(row) !== null ? [row.sessionId] : []) } };
    });
}

/** Reads relationship default rules and creation policies through their private Account owner. */
export async function getSessionAutoFollowPreferences(input: Readonly<{ accountId: string }>): Promise<AccountFollowResult<SessionAutoFollowPreferencesV1>> {
    return await inReadSnapshot(async tx => {
        const account = await activeAccount(tx, input.accountId);
        return account ? { ok: true, value: { ...projectPreferences(account),
            ...await readAccountFollowCreationPreferencesInTx(tx, input.accountId) } } : { ok: false, error: "account_inactive" };
    });
}

/** Updates default rules and creation policies without scanning or mutating existing Sessions. */
export async function setSessionAutoFollowPreferences(input: Readonly<{
    accountId: string; preferences: SessionAutoFollowPreferencesV1;
}>): Promise<AccountFollowResult<SessionAutoFollowPreferencesV1>> {
    const parsed = SessionAutoFollowPreferencesV1Schema.safeParse(input.preferences);
    if (!parsed.success) return { ok: false, error: "invalid_parameters" };
    const preferences = parsed.data;
    return await inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
        const account = await activeAccount(tx, input.accountId);
        if (!account) return { ok: false, error: "account_inactive" };
        const current = projectPreferences(account);
        const creation = await updateAccountFollowCreationPreferencesInTx(tx, { accountId: input.accountId, patch: {
            ...(preferences.managerPolicy ? { managerPolicy: preferences.managerPolicy } : {}),
            ...(preferences.runReportPolicy ? { runReportPolicy: preferences.runReportPolicy } : {}),
            ...(preferences.discussionReceivePolicy ? { discussionReceivePolicy: preferences.discussionReceivePolicy } : {}),
        } });
        const relationshipsChanged = (['assigned', 'direct', 'team', 'group'] as const).some(key => current[key] !== preferences[key]);
        if (relationshipsChanged) {
            await tx.account.update({ where: { id: input.accountId }, data: {
                sessionAutoFollowAssigned: preferences.assigned, sessionAutoFollowDirect: preferences.direct,
                sessionAutoFollowTeam: preferences.team, sessionAutoFollowGroup: preferences.group,
            } });
        }
        if (relationshipsChanged || creation.changed) await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        return { ok: true, value: { ...preferences, ...creation.policies } };
    });
}


/** Final effective read loss contracts active interest; explicit user suppression remains intact. */
export async function removeAccountSessionFollowsOnAccessLossInTx(tx: Tx, input: Readonly<{
    sessionId: string; accountIds: readonly string[];
}>): Promise<number> {
    const candidates = await tx.accountSessionFollow.findMany({ where: {
        sessionId: input.sessionId, accountId: { in: [...new Set(input.accountIds)] }, following: true,
    }, select: { accountId: true } });
    if (candidates.length === 0) return 0;
    const access = await resolveStructuralSessionAccessForAccountsInTx(tx, {
        sessionId: input.sessionId, accountIds: candidates.map(row => row.accountId),
    });
    const revoked = candidates
        .map(row => row.accountId)
        .filter(accountId => access.get(accountId)?.capabilities.readTranscript !== true);
    if (revoked.length === 0) return 0;
    const result = await tx.accountSessionFollow.deleteMany({ where: { sessionId: input.sessionId, accountId: { in: revoked }, following: true } });
    await markSessionFollowsChangedForAccountsInTx(tx, revoked);
    return result.count;
}

const VOICE_SOURCE_SELECT = {
    id: true,
    archivedAt: true,
    seq: true,
    latestReadyEventSeq: true,
    agentStateVersion: true,
    latestTurnId: true,
    latestTurnStatus: true,
    active: true,
} as const;

export type PendingAccountVoiceFollowObservationV1 = Readonly<{
    sourceSessionId: string;
    voiceSessionId: string;
    expected: SessionFollowFrontierV1 | null;
    observed: SessionFollowFrontierV1;
    policy?: FollowPolicyV1;
}>;

/** Content-free Account Voice observer; null means one current snapshot is pending. */
export async function observePendingAccountVoiceFollowInTx(tx: Tx, input: Readonly<{
    accountId: string;
    voiceSessionId: string;
    authentication: SessionAccessAuthentication;
    runtimeAuthority?: CurrentAccountVoiceExecutionRunAuthority;
}>): Promise<readonly PendingAccountVoiceFollowObservationV1[] | null> {
    if (!await activeAccount(tx, input.accountId)) return null;
    if (!await hasCurrentPrivateAccountVoicePublisherInTx(tx, input)) return null;
    const muteScopes = await readDeliveryMuteScopesInTx(tx, { receiver: { kind: 'account' }, accountId: input.accountId });
    if (muteScopes === null) return null;
    const follows = await tx.accountSessionFollow.findMany({
        where: { accountId: input.accountId, following: true, sessionId: { not: null },
            OR: [{ includeInVoice: true }, { followPolicy: { not: null } }] },
        select: { sessionId: true, voiceDeliveredFrontier: true, includeInVoice: true, followPolicy: true },
        orderBy: { sessionId: 'asc' },
    });
    const pending: PendingAccountVoiceFollowObservationV1[] = [];
    for (const follow of follows) {
        if (follow.sessionId === null) continue;
        const selection = resolveAccountVoiceSelection(follow);
        if (selection === null) continue;
        if (follow.sessionId === input.voiceSessionId) continue;
        const source = await tx.session.findUnique({ where: { id: follow.sessionId }, select: VOICE_SOURCE_SELECT });
        if (!source || source.archivedAt !== null) continue;
        if ((await resolveEffectiveSessionAccess(tx, {
            accountId: input.accountId,
            sessionId: source.id,
            authentication: input.authentication,
        }))?.capabilities.readTranscript !== true) continue;
        if (isFollowDeliveryMutedV1(muteScopes, { senderSessionId: source.id, source: { kind: 'session', sessionId: source.id } })) continue;
        const expected = follow.voiceDeliveredFrontier === null
            ? null
            : parsePersistedSessionFollowFrontierV1(follow.voiceDeliveredFrontier);
        // Malformed persisted bytes fail closed; null alone is the pending-current sentinel.
        if (follow.voiceDeliveredFrontier !== null && expected === null) continue;
        const observed = projectSessionFollowFrontierFromSourceV1(source);
        if (expected !== null && compareSessionFollowFrontierProgressV1(expected, observed) !== 'ahead') continue;
        pending.push({ sourceSessionId: source.id, voiceSessionId: input.voiceSessionId, expected, observed, ...selection });
    }
    return pending;
}

export type AccountVoiceFollowAcknowledgeRejection =
    | 'forbidden'
    | 'not_followed'
    | 'session_archived'
    | 'stale_expected_frontier'
    | 'stale_terminal_turn'
    | 'invalid_consumed_frontier'
    | 'provider_acceptance_unverified'
    | 'source_forbidden';

export async function acknowledgeAccountVoiceFollowInTx(tx: Tx, input: Readonly<{
    accountId: string;
    voiceSessionId: string;
    sourceSessionId: string;
    expected: SessionFollowFrontierV1 | null;
    observed: SessionFollowFrontierV1;
    consumed: SessionFollowFrontierV1;
    policy?: FollowPolicyV1;
    acceptance: Readonly<{ localInputId: string; userMessageSeq: number | null }>;
    authentication: SessionAccessAuthentication;
    runtimeAuthority?: CurrentAccountVoiceExecutionRunAuthority;
}>): Promise<Readonly<{ ok: true; delivered: SessionFollowFrontierV1 }>
    | Readonly<{ ok: false; rejection: AccountVoiceFollowAcknowledgeRejection }>> {
    if (!await activeAccount(tx, input.accountId)) return { ok: false, rejection: 'forbidden' };
    if (!await hasCurrentPrivateAccountVoicePublisherInTx(tx, input)) return { ok: false, rejection: 'forbidden' };
    if (
        !input.acceptance
        || typeof input.acceptance.localInputId !== 'string'
        || input.acceptance.localInputId.trim().length === 0
        || !(
            input.acceptance.userMessageSeq === null
            || Number.isSafeInteger(input.acceptance.userMessageSeq) && input.acceptance.userMessageSeq >= 0
        )
    ) return { ok: false, rejection: 'provider_acceptance_unverified' };
    if (!await hasCanonicalFollowProviderInputAcceptanceInTx(tx, {
        destinationSessionId: input.voiceSessionId,
        localInputId: input.acceptance.localInputId,
        userMessageSeq: input.acceptance.userMessageSeq,
    })) return { ok: false, rejection: 'provider_acceptance_unverified' };
    const source = await tx.session.findUnique({ where: { id: input.sourceSessionId }, select: VOICE_SOURCE_SELECT });
    if (!source) return { ok: false, rejection: 'not_followed' };
    if (source.archivedAt !== null) return { ok: false, rejection: 'session_archived' };
    if ((await resolveEffectiveSessionAccess(tx, {
        accountId: input.accountId,
        sessionId: source.id,
        authentication: input.authentication,
    }))?.capabilities.readTranscript !== true) return { ok: false, rejection: 'source_forbidden' };
    const key = { accountId: input.accountId, sessionId: input.sourceSessionId };
    const follow = await tx.accountSessionFollow.findUnique({
        where: { accountId_sessionId: key },
        select: { following: true, includeInVoice: true, voiceDeliveredFrontier: true, followPolicy: true },
    });
    const selection = follow?.following ? resolveAccountVoiceSelection(follow) : null;
    if (!follow || selection === null) return { ok: false, rejection: 'not_followed' };
    if (selection.policy ? !input.policy || !isFollowPolicyEqualV1(selection.policy, input.policy) : input.policy !== undefined) {
        return { ok: false, rejection: 'stale_expected_frontier' };
    }
    if (await isDeliveryMutedInTx(tx, { receiver: { kind: 'account' }, accountId: input.accountId,
        candidate: { senderSessionId: source.id, source: { kind: 'session', sessionId: source.id } } }) !== false) {
        return { ok: false, rejection: 'not_followed' };
    }
    const stored = follow.voiceDeliveredFrontier === null
        ? null
        : parsePersistedSessionFollowFrontierV1(follow.voiceDeliveredFrontier);
    if (follow.voiceDeliveredFrontier !== null && stored === null) return { ok: false, rejection: 'stale_expected_frontier' };
    if (stored === null ? input.expected !== null : input.expected === null || !isSessionFollowFrontierEqualV1(stored, input.expected)) {
        return { ok: false, rejection: 'stale_expected_frontier' };
    }
    const current = projectSessionFollowFrontierFromSourceV1(source);
    const baseline = input.expected ?? { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    if (!isSessionFollowConsumptionWithinCurrentV1({
        expected: baseline,
        observed: input.observed,
        consumed: input.consumed,
        current,
    })) {
        return { ok: false, rejection: 'invalid_consumed_frontier' };
    }
    if (!isSessionFollowTurnEqualV1(current.turn, input.consumed.turn)) {
        return { ok: false, rejection: 'stale_terminal_turn' };
    }
    const written = await tx.accountSessionFollow.updateMany({
        where: {
            ...key,
            following: true,
            includeInVoice: follow.includeInVoice,
            followPolicy: follow.followPolicy,
            voiceDeliveredFrontier: follow.voiceDeliveredFrontier,
        },
        data: { voiceDeliveredFrontier: encodePersistedSessionFollowFrontierV1(input.consumed) },
    });
    return written.count === 1
        ? { ok: true, delivered: input.consumed }
        : { ok: false, rejection: 'stale_expected_frontier' };
}
