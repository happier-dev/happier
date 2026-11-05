import { isActiveHomeAccountStatus } from '@happier-dev/protocol/home/governance';
import { isApiTokenGrantRestrictedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { SessionFollowRuleStoredRowV1Schema, SetSessionFollowRuleRequestV1Schema, buildSessionFollowRulePhysicalKeyV1,
    parseSessionFollowRulePhysicalKeyV1, SESSION_FOLLOW_RULE_ACCOUNT_PREFIX_V1, assertSessionFollowRuleContentForModeV1,
    equalFollowRuleReceiverV1,
    type SessionFollowRuleStoredRowV1, type SessionFollowRuleV1, type SessionFollowRuleFailureV1, type SetSessionFollowRuleRequestV1,
    type ListSessionFollowRulesResponseV1,
} from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1, type SessionFollowFrontierV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import type { FollowReceiverRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { listReservedAccountScopedKvRowsInTx, readReservedAccountScopedKvRowInTx, mutateReservedAccountScopedKvRowInTx,
    type ReservedAccountScopedKvRowDomain, type ReservedAccountScopedKvRowFailure } from '@/app/kv/reservedAccountScopedKvRow';
import { resolveEffectiveSessionAccess } from '@/app/session/access/sessionAccess';
import { mayInjectSessionContextInTx } from '@/app/session/access/sessionContextInjection';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { SessionCollectiveAccessSnapshot } from '@/app/session/access/sessionAccessWhere';
import { inReadSnapshot, inTx, type Tx } from '@/storage/inTx';
import { readSnapshotWithCurrentAdmission } from '@/storage/readSnapshotWithCurrentAdmission';
import { markSessionFollowsChangedInTx } from './changes';
import type { AccountChangePublication } from '@/app/changes/markAccountChanged';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { UserKvMutationConflictError } from '@/app/kv/kvMutate';
import { portableQueryChunks } from '@/storage/portableQueryChunks';

export async function markAccountFollowRulesChangedInTx(tx: Tx, input: Readonly<{ accountId: string }>): Promise<AccountChangePublication> {
    return markSessionFollowsChangedInTx(tx, input);
}

export const accountFollowRuleRowDomain: ReservedAccountScopedKvRowDomain<SessionFollowRuleStoredRowV1> = {
    label: 'Account private Follow rule',
    parseStoredEnvelope(value) { const parsed = SessionFollowRuleStoredRowV1Schema.safeParse(value); return parsed.success ? parsed.data : null; },
    parseCandidateEnvelope(value) { const parsed = SessionFollowRuleStoredRowV1Schema.safeParse(value); return parsed.success ? parsed.data : null; },
    assertEnvelopeForMode(row, mode) { assertSessionFollowRuleContentForModeV1(row.content, mode); },
};
type Scope = Readonly<{ accountId: string; authentication: SessionAccessAuthentication }>;
type ProjectionScope = Scope & Readonly<{
    collectiveAccessSnapshot?: SessionCollectiveAccessSnapshot;
}>;
type RuleResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: SessionFollowRuleFailureV1 }>;

function failure(result: ReservedAccountScopedKvRowFailure): { ok: false; error: SessionFollowRuleFailureV1 } {
    switch (result.status) {
        case 'account-not-found': return { ok: false, error: 'account_inactive' };
        case 'account-inconsistent': return { ok: false, error: 'account_inconsistent' };
        case 'account-mode-mismatch': return { ok: false, error: 'account_mode_mismatch' };
        case 'invalid-stored-content': return { ok: false, error: 'invalid_stored_content' };
    }
}
/** Retained rows already have an authoritative creation instant in their owning KV row. */
async function withRuleInceptionInTx(tx: Tx, accountId: string, physicalKey: string, envelope: SessionFollowRuleStoredRowV1) {
    if (envelope.inception) return envelope;
    const row = await tx.userKVStore.findUnique({ where: { accountId_key: { accountId, key: physicalKey } }, select: { createdAt: true } });
    return row ? { ...envelope, inception: { createdAt: row.createdAt.getTime() } } : envelope;
}
export async function readAccountFollowRuleInTx(tx: Tx, input: Readonly<{ accountId: string; ruleId: string }>) {
    const physicalKey = buildSessionFollowRulePhysicalKeyV1(input.ruleId);
    const row = await readReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId,
        physicalKey, domain: accountFollowRuleRowDomain });
    return row.status === 'present' ? { ...row, envelope: await withRuleInceptionInTx(tx, input.accountId, physicalKey, row.envelope) } : row;
}
export async function listAccountFollowRuleRowsInTx(tx: Tx, input: Readonly<{ accountId: string }>) {
    const result = await listReservedAccountScopedKvRowsInTx(tx, { ...input, physicalPrefix: SESSION_FOLLOW_RULE_ACCOUNT_PREFIX_V1, domain: accountFollowRuleRowDomain });
    if (result.status !== 'listed') return result;
    const missing = result.rows.filter(row => row.envelope && !row.envelope.inception).map(row => row.physicalKey);
    if (!missing.length) return result;
    const inceptionByKey = new Map<string, number>();
    // Same-snapshot creation facts; chunks reserve the Account and Prisma OFFSET binds at the portable SQL boundary.
    for (const keys of portableQueryChunks({ values: missing, bindingsPerValue: 1, fixedBindings: 2 })) {
        const rows = await tx.userKVStore.findMany({ where: { accountId: input.accountId, key: { in: [...keys] } },
            select: { key: true, createdAt: true } });
        for (const row of rows) inceptionByKey.set(row.key, row.createdAt.getTime());
    }
    return { ...result, rows: result.rows.map(row => {
        const createdAt = inceptionByKey.get(row.physicalKey);
        return row.envelope && !row.envelope.inception && createdAt !== undefined
            ? { ...row, envelope: { ...row.envelope, inception: { createdAt } } } : row;
    }) };
}
async function admitAccount(tx: Tx, input: ProjectionScope): Promise<SessionFollowRuleFailureV1 | null> {
    if (input.authentication.sessionRuntimePrincipal
        || input.authentication.apiTokenGrant && isApiTokenGrantRestrictedV1(input.authentication.apiTokenGrant)) return 'credential_scope_denied';
    let accountActive = input.collectiveAccessSnapshot?.accountActive;
    if (accountActive === undefined) {
        const account = await tx.account.findUnique({ where: { id: input.accountId }, select: { status: true } });
        accountActive = account !== null && isActiveHomeAccountStatus(account.status);
    }
    return accountActive ? null : 'account_inactive';
}

/** Content-free private membership for the existing batched Session projection, not another rule census. */
export async function readAccountFollowRuleReceiverCountsInTx(tx: Tx, input: ProjectionScope): Promise<ReadonlyMap<string, number> | null> {
    if (await admitAccount(tx, input)) return null;
    // Receiver counts need admitted envelopes, not each retained rule's creation instant.
    const listed = await listReservedAccountScopedKvRowsInTx(tx, {
        accountId: input.accountId, physicalPrefix: SESSION_FOLLOW_RULE_ACCOUNT_PREFIX_V1, domain: accountFollowRuleRowDomain,
    });
    return projectAccountFollowRuleReceiverCounts(listed);
}

export type AccountFollowRuleProjectionRows = Awaited<ReturnType<typeof listAccountFollowRuleRowsInTx>> | null;

/** One private census for a containing read that needs both receiver counts and inception facts. */
export async function readAccountFollowRuleProjectionRowsInTx(tx: Tx, input: ProjectionScope): Promise<AccountFollowRuleProjectionRows> {
    if (await admitAccount(tx, input)) return null;
    return listAccountFollowRuleRowsInTx(tx, input);
}

export function projectAccountFollowRuleReceiverCounts(listed: AccountFollowRuleProjectionRows): ReadonlyMap<string, number> | null {
    if (listed?.status !== 'listed') return null;
    const counts = new Map<string, number>();
    for (const row of listed.rows) {
        // An unaddressable row cannot establish rule membership. Keep the
        // admitted rules usable rather than withdrawing the entire census.
        if (parseSessionFollowRulePhysicalKeyV1(row.physicalKey) === null) continue;
        if (row.envelope?.receiver.kind === 'session') {
            const id = row.envelope.receiver.sessionId;
            counts.set(id, (counts.get(id) ?? 0) + 1);
        }
    }
    // The caller only projects entries onto currently admitted, own-Account Session rows.
    return counts;
}
async function admitReceiver(tx: Tx, input: Scope, receiver: FollowReceiverRefV1, writing: boolean): Promise<SessionFollowRuleFailureV1 | null> {
    if (receiver.kind === 'account') return null;
    const session = await tx.session.findUnique({ where: { id: receiver.sessionId }, select: { accountId: true, archivedAt: true } });
    if (session?.accountId !== input.accountId) return 'session_not_found';
    const access = await resolveEffectiveSessionAccess(tx, { ...input, sessionId: receiver.sessionId });
    if (access?.capabilities.readTranscript !== true) return 'session_not_found';
    return writing && session.archivedAt !== null ? 'session_archived' : null;
}
function projectRule(ruleId: string, row: SessionFollowRuleStoredRowV1): SessionFollowRuleV1 {
    return { ruleId, version: row.version, receiver: row.receiver, content: row.content,
        ...(row.inception ? { inception: row.inception } : {}),
        ...(row.sources ? { sources: row.sources } : {}) };
}

/**
 * Demand-driven first ranges come from the Account's existing coalesced change
 * frontier, never a Session census or a rule membership writer. Original rows
 * supply the creation cutoff; accepted progress remains the only cursor writer.
 */
async function readRuleSourceRangesInTx(tx: Tx, input: Scope & Readonly<{ destinationSessionId: string; sourceSessionId?: string }>, rules: readonly SessionFollowRuleV1[])
    : Promise<NonNullable<ListSessionFollowRulesResponseV1['sourceRanges']>> {
    const relevant = rules.filter(rule => rule.receiver.kind === 'session' && rule.receiver.sessionId === input.destinationSessionId);
    if (!relevant.length) return { status: 'available', sources: [] };
    const destination = await tx.session.findUnique({ where: { id: input.destinationSessionId }, select: { accountId: true, archivedAt: true } });
    if (destination?.accountId !== input.accountId || destination.archivedAt !== null) return { status: 'unavailable', sources: [] };
    const account = await tx.account.findUniqueOrThrow({ where: { id: input.accountId }, select: { changesFloor: true } });
    let available = true;
    const candidates = new Map<string, SessionFollowRuleV1[]>();
    const add = (sourceSessionId: string, rule: SessionFollowRuleV1) => {
        if (sourceSessionId === input.destinationSessionId || input.sourceSessionId !== undefined && sourceSessionId !== input.sourceSessionId) return;
        const routes = candidates.get(sourceSessionId) ?? [];
        if (!routes.includes(rule)) routes.push(rule);
        candidates.set(sourceSessionId, routes);
    };
    for (const rule of relevant) for (const source of rule.sources ?? []) add(source.sourceSessionId, rule);
    const inceptions = relevant.flatMap(rule => rule.inception ? [rule.inception] : []);
    if (inceptions.length !== relevant.length) available = false;
    if (inceptions.length) {
        const cursors = inceptions.flatMap(inception => inception.accountChangeCursor === undefined ? [] : [inception.accountChangeCursor]);
        const retainedDates = inceptions.filter(inception => inception.accountChangeCursor === undefined).map(inception => inception.createdAt);
        const changes = await tx.accountChange.findMany({ where: { accountId: input.accountId, kind: 'session',
            ...(input.sourceSessionId ? { entityId: input.sourceSessionId } : {}), OR: [
            ...(cursors.length ? [{ cursor: { gt: Math.min(...cursors) } }] : []),
            ...(retainedDates.length ? [{ changedAt: { gte: new Date(Math.min(...retainedDates)) } }] : []),
        ] }, select: { entityId: true, cursor: true, changedAt: true } });
        for (const rule of relevant) {
            const inception = rule.inception;
            if (!inception) continue;
            if (inception.accountChangeCursor !== undefined && inception.accountChangeCursor < account.changesFloor) available = false;
            for (const change of changes) if (inception.accountChangeCursor === undefined
                ? change.changedAt.getTime() >= inception.createdAt : change.cursor > inception.accountChangeCursor) add(change.entityId, rule);
        }
    }
    const sources: NonNullable<ListSessionFollowRulesResponseV1['sourceRanges']>['sources'] = [];
    for (const [sourceSessionId, routes] of candidates) {
        const source = await tx.session.findUnique({ where: { id: sourceSessionId }, select: { seq: true, archivedAt: true } });
        if (!source || source.archivedAt !== null || !(await mayInjectSessionContextInTx(tx, { configuringAccountId: input.accountId,
            authentication: input.authentication, sourceSessionId, destinationSessionId: input.destinationSessionId })).ok) {
            available = false;
            continue;
        }
        let delivered: SessionFollowFrontierV1 | null = null;
        for (const rule of routes) {
            const progress = rule.sources?.find(candidate => candidate.sourceSessionId === sourceSessionId)?.delivered;
            if (!progress && !rule.inception) { available = false; continue; }
            const beforeCreation = !progress && rule.inception ? await tx.sessionMessage.findFirst({ where: {
                sessionId: sourceSessionId, createdAt: { lt: new Date(rule.inception.createdAt) },
            }, orderBy: { seq: 'desc' }, select: { seq: true } }) : null;
            const baseline = progress ?? { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: beforeCreation?.seq ?? 0 };
            delivered = delivered ? { transcriptSeq: Math.min(delivered.transcriptSeq, baseline.transcriptSeq),
                agentStateVersion: Math.min(delivered.agentStateVersion, baseline.agentStateVersion),
                readyEventSeq: delivered.readyEventSeq, turn: delivered.turn } : baseline;
        }
        if (delivered) sources.push({ sourceSessionId, delivered, throughSeq: source.seq });
    }
    return { status: available ? 'available' : 'unavailable', sources };
}
/** Full own-Account census, including Session receivers; unreadable content never becomes an empty rule set. */
export async function listAccountFollowRules(input: Scope & Readonly<{ destinationSessionId?: string; sourceSessionId?: string }>): Promise<RuleResult<ListSessionFollowRulesResponseV1>> {
    return readSnapshotWithCurrentAdmission(async tx => {
        const denied = await admitAccount(tx, input);
        if (denied) return { ok: false as const, error: denied };
        const rows = await listAccountFollowRuleRowsInTx(tx, input);
        if (rows.status !== 'listed') return failure(rows);
        const rules: SessionFollowRuleV1[] = [];
        for (const row of rows.rows) {
            const ruleId = parseSessionFollowRulePhysicalKeyV1(row.physicalKey);
            if (ruleId === null) return { ok: false as const, error: 'invalid_stored_content' as const };
            if (row.envelope === null) continue;
            rules.push(projectRule(ruleId, row.envelope));
        }
        const sourceRanges = input.destinationSessionId ? await readRuleSourceRangesInTx(tx, { ...input,
            destinationSessionId: input.destinationSessionId }, rules) : undefined;
        return { ok: true as const, value: { rules, ...(sourceRanges ? { sourceRanges } : {}) } };
    }, async (tx, captured) => {
        if (!captured.ok) return captured;
        const denied = await admitAccount(tx, input);
        if (denied) return { ok: false as const, error: denied };
        return captured;
    });
}
/** Reads only the caller's row; another Account's same rule id is absent. */
export async function getAccountFollowRule(input: Scope & Readonly<{ ruleId: string }>): Promise<RuleResult<{ rule: SessionFollowRuleV1 | null }>> {
    return inReadSnapshot(async tx => {
        const denied = await admitAccount(tx, input);
        if (denied) return { ok: false, error: denied };
        const row = await readAccountFollowRuleInTx(tx, input);
        if (row.status === 'absent' || row.status === 'deleted') return { ok: true, value: { rule: null } };
        if (row.status !== 'present') return failure(row);
        return { ok: true, value: { rule: projectRule(input.ruleId, row.envelope) } };
    });
}
/** Rule authoring preserves progress. Undo restores only the acknowledged deletion's exact CAS version. */
export async function setAccountFollowRule(input: Scope & Readonly<{ ruleId: string; mutation: SetSessionFollowRuleRequestV1 }>): Promise<RuleResult<{ rule: SessionFollowRuleV1 }>> {
    const parsed = SetSessionFollowRuleRequestV1Schema.safeParse(input.mutation);
    if (!parsed.success) return { ok: false, error: 'invalid_parameters' };
    const mutation = parsed.data;
    return inTx(async (tx): Promise<RuleResult<{ rule: SessionFollowRuleV1 }>> => {
        const denied = await admitAccount(tx, input) ?? await admitReceiver(tx, input, mutation.receiver, true);
        if (denied) return { ok: false, error: denied };
        const current = await readAccountFollowRuleInTx(tx, input);
        if (current.status !== 'present' && current.status !== 'absent' && current.status !== 'deleted') return failure(current);
        const expectedVersion = current.status === 'absent' ? -1
            : current.status === 'deleted' ? current.revision : current.envelope.version;
        if (mutation.expectedVersion !== expectedVersion) {
            return { ok: false, error: 'version_conflict' };
        }
        if (current.status === 'present' && !equalFollowRuleReceiverV1(current.envelope.receiver, mutation.receiver)) {
            return { ok: false, error: 'invalid_parameters' };
        }
        let inception = current.status === 'present' ? current.envelope.inception : undefined;
        if (current.status !== 'present') {
            // Capture after entering the mutation's incumbent Account fence,
            // so waiting for that fence cannot turn old work into new history.
            const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId, "content");
            if (fence.status === 'account_not_found') return { ok: false, error: 'account_inactive' };
            if (fence.status === 'account_inconsistent') return { ok: false, error: 'account_inconsistent' };
            inception = { createdAt: Date.now(), accountChangeCursor: fence.account.version };
        }
        const envelope = { ...(current.status === 'present' ? current.envelope : {}), version: mutation.expectedVersion + 1,
            ...(inception ? { inception } : {}),
            receiver: mutation.receiver, content: mutation.content };
        const result = await mutateReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId,
            physicalKey: buildSessionFollowRulePhysicalKeyV1(input.ruleId), expectedRevision: current.status === 'absent' ? 'absent' : current.revision,
            envelope, domain: accountFollowRuleRowDomain,
            markChanged: ({ tx: changeTx }) => markAccountFollowRulesChangedInTx(changeTx, input) });
        if (result.status === 'conflict') return { ok: false, error: 'version_conflict' };
        return result.status === 'updated' ? { ok: true, value: { rule: projectRule(input.ruleId, envelope) } } : failure(result);
    }).catch((error: unknown) => {
        if (error instanceof UserKvMutationConflictError) return { ok: false as const, error: 'version_conflict' as const };
        throw error;
    });
}
/** Versioned deletion is Account-private and leaves a content-free tombstone. */
export async function removeAccountFollowRule(input: Scope & Readonly<{ ruleId: string; receiver: FollowReceiverRefV1; expectedVersion: number }>): Promise<RuleResult<{ changed: boolean; version: number }>> {
    return inTx(async (tx): Promise<RuleResult<{ changed: boolean; version: number }>> => {
        const denied = await admitAccount(tx, input);
        if (denied) return { ok: false, error: denied };
        const row = await readAccountFollowRuleInTx(tx, input);
        if (row.status === 'absent' || row.status === 'deleted') return { ok: false, error: 'version_conflict' };
        if (row.status !== 'present') return failure(row);
        if (row.envelope.version !== input.expectedVersion) return { ok: false, error: 'version_conflict' };
        if (!equalFollowRuleReceiverV1(row.envelope.receiver, input.receiver)) return { ok: false, error: 'invalid_parameters' };
        const result = await mutateReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId,
            physicalKey: buildSessionFollowRulePhysicalKeyV1(input.ruleId), expectedRevision: row.revision, envelope: null, domain: accountFollowRuleRowDomain,
            markChanged: ({ tx: changeTx }) => markAccountFollowRulesChangedInTx(changeTx, input) });
        if (result.status === 'conflict') return { ok: false, error: 'version_conflict' };
        return result.status === 'updated' ? { ok: true, value: { changed: true, version: result.revision } } : failure(result);
    }).catch((error: unknown) => {
        if (error instanceof UserKvMutationConflictError) return { ok: false as const, error: 'version_conflict' as const };
        throw error;
    });
}
