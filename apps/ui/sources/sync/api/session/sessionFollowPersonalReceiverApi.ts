import type { SessionListFilterFactsV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { readOpenedSessionFollowOriginalV1, captureSemanticSessionFollowRuleSourceEvidenceV1,
    type SessionFollowOriginalOccurrenceV1, type SessionFollowRuleSourceEvidenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import { SESSION_FOLLOW_PERSONAL_PROGRESS_ROUTE_V1, SessionFollowPersonalProgressRequestV1Schema, SessionFollowPersonalProgressResponseV1Schema,
    type SessionFollowPersonalProgressRequestV1, type SessionFollowPersonalProgressResponseV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { SessionFollowObserveSourceRoutesRequestV1Schema, SessionFollowObserveSourceRoutesResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { SessionFollowSourceRequestsV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';
import { resolveRequestFollowEventV1, type FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { resolvePendingRequestAttentionReasonV1 } from '@happier-dev/protocol/sessions/personal/attention';
import { readRunScopedExecutionPermissionRequestIdentity } from '@happier-dev/protocol/execution/runs/runPrimitives';
import { fetchSessionMessagesPage, openSessionStoredContent, type SessionStoredContentContext } from '@happier-dev/sync-client';
import { readStoredSessionMessages, type Message } from '@happier-dev/session-core/messages';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { classifyInboxSessionCandidate } from '@/activity/presentation/buildInboxSessionPresentation';
import { readCredentialAuthorityKind } from '@/auth/context/credentialAuthority';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { buildSessionListRowFilterFacts } from '@/sync/domains/session/listing/sessionListWorkFilter';
import { listPendingSessionRequests } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { readPendingNavigationDetailsForAuthority } from '@/sync/ops/sessionPendingNavigationDetails';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';
import { readProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { createSessionProjectKeyResolverV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { getStorage } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { captureEncryptionGenerationCurrentness } from '@/sync/encryption/encryption';
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { runWithServerRequestAuthorityForServerAccountScope, type ServerAccountRequestAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { readSessionSnapshotsForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { assertSessionFollowRulesScope, type AcquiredSessionFollowRulesSnapshot } from './sessionFollowRulesApi';
import type { SessionFollowRuleWitnessV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';

export type SessionFollowPersonalReceiverOccurrence = Readonly<{
    sourceSessionId: string;
    production: 'source' | 'recovery';
    original: SessionFollowOriginalOccurrenceV1;
    evidence: SessionFollowRuleSourceEvidenceV1;
    currentFacts: SessionListFilterFactsV1;
    terminalSourceMessage?: Readonly<{ localId: string; seq: number }>;
    personalFollowSuppressed: boolean;
    originalCreatedAt?: number;
    isRepresentedInInbox(policies: readonly FollowPolicyV1[], rules?: readonly SessionFollowRuleWitnessV1[]): boolean;
}>;
type ReceiverCapture = Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    snapshot: AcquiredSessionFollowRulesSnapshot;
    signal?: AbortSignal;
}>;

function unavailable(code = 'session_follow_receiver_unavailable'): never { throw Object.assign(new Error(code), { code }); }

/** Borrow the incumbent Account authority; private definitions were admitted by the census owner. */
async function withReceiverAuthority<T>(input: ReceiverCapture,
    operation: (authority: ServerAccountRequestAuthority, check: () => void, signal: AbortSignal) => Promise<T>,
): Promise<T> {
    return runWithServerAccountScopeRequestGuard({ scope: input.lifetime.scope, signal: input.signal,
        isCurrent: input.lifetime.isCurrent, staleError: () => new Error('scope-retired'),
    }, guard => runWithServerRequestAuthorityForServerAccountScope({ scope: input.lifetime.scope,
        activeRequest: async () => unavailable(),
    }, async authority => {
        const credentials = authority.context.credentials;
        if (!credentials || readCredentialAuthorityKind(credentials.token) !== 'account') unavailable('forbidden');
        const encryptionCurrentness = captureEncryptionGenerationCurrentness(authority.context.encryption, input.lifetime.scope);
        const check = () => { guard.check(); if (!encryptionCurrentness.isCurrent()) unavailable('scope-retired'); };
        check();
        const account = await resolveAccountStorageContext(credentials, {
            encryption: authority.context.encryption, request: authority.request, usage: 'fresh-authority',
        });
        check();
        assertSessionFollowRulesScope(input.snapshot, { ...input.lifetime.scope, mode: account.mode,
            credentialScopeKey: resolveAuthCredentialsScopeKey(credentials) });
        return operation(authority, check, guard.signal);
    }));
}

/** Demand-driven original traversal, using only durable Follow-owned source frontiers. */
export async function visitSessionFollowPersonalReceiverOriginals(input: ReceiverCapture & Readonly<{
    sourceSessionIds: readonly string[];
    onOccurrence(occurrence: SessionFollowPersonalReceiverOccurrence): Promise<boolean>;
}>): Promise<void> {
    if (!input.sourceSessionIds.length || !input.snapshot.rules.some(rule => rule.receiver.kind === 'account' && rule.definition.enabled)) return;
    await withReceiverAuthority(input, async (authority, check, signal) => {
        const { serverId, accountId } = input.lifetime.scope;
        const current = getStorage().getState();
        const rows = current.profileScope?.accountId === accountId
            && areServerProfileIdentifiersEquivalent(current.profileScope.serverId, serverId)
            ? readSessionListRowsForServerId(current.sessionListRowsByServerId, serverId)
            : null;
        // The source daemon evaluates this Account's own Sessions. Missing
        // ownership facts still need the authoritative snapshot below.
        const sessionIds = [...new Set(input.sourceSessionIds)].filter(id => rows?.[id]?.ownerAccountId !== accountId);
        if (sessionIds.length === 0) return;
        const rules = input.snapshot.rules.filter(rule => rule.receiver.kind === 'account' && rule.definition.enabled);
        const earliestInception = rules.reduce((earliest, rule) => Math.min(earliest, rule.inception?.createdAt ?? Infinity), Infinity);
        const snapshots = await readSessionSnapshotsForAuthority({ authority, sessionIds, includeTurns: false,
            signal, isCurrent: () => { check(); return true; } });
        check();
        const state = getStorage().getState();
        if (!state.isDataReady || state.profileScope?.accountId !== input.lifetime.scope.accountId
            || !areServerProfileIdentifiersEquivalent(state.profileScope.serverId, input.lifetime.scope.serverId)) unavailable('scope-retired');
        const workspaceRefs = readProjectAccountWorkspaceRefs(state);
        const sessionProjectKeyResolver = createSessionProjectKeyResolverV1(workspaceRefs, workspaceRefResolutionContextV1());
        for (const sourceSessionId of sessionIds) {
            const result = snapshots.get(sourceSessionId);
            if (!result?.ok) continue;
            const { session } = result.snapshot;
            const ownerAccountId = session.ownerAccountId;
            // The source daemon owns this case. A missing publisher is not proof of recovery.
            if (!ownerAccountId || ownerAccountId === input.lifetime.scope.accountId || session.access?.capabilities.readTranscript !== true) continue;
            const encryption = authority.context.encryption?.getSessionEncryption(sourceSessionId) ?? null;
            const contentContext: SessionStoredContentContext | null = session.encryptionMode === 'plain' ? { mode: 'plain' }
                : session.encryptionMode === 'e2ee' && encryption ? { mode: 'e2ee', encryption } : null;
            if (!contentContext) continue;
            const organizationKey = buildSessionOrganizationSessionKey(input.lifetime.scope.serverId, sourceSessionId);
            const folder = state.sessionOrganizationFolderAssignmentsBySessionKey[organizationKey];
            let sourceMessages: readonly Message[] = readStoredSessionMessages(state, sourceSessionId) ?? [];
            const currentFacts = buildSessionListRowFilterFacts(session, input.lifetime.scope.serverId, {
                nowMs: Date.now(), viewerAccountId: input.lifetime.scope.accountId,
                workspaceRefs, workspaceRefsServerId: state.profileScope.serverId, sessionProjectKeyResolver,
                tagIds: state.sessionOrganizationTagAssignmentsBySessionKey[organizationKey]?.tagIds,
                section: folder === undefined ? undefined : folder.folderId === null ? null
                    : { serverId: input.lifetime.scope.serverId, sectionId: folder.folderId },
                includeStatus: rules.some(rule => Boolean(rule.definition.filter.statuses?.include.length || rule.definition.filter.statuses?.exclude.length)),
                includeAgent: rules.some(rule => Boolean(rule.definition.filter.agents
                    && rule.definition.filter.agents.include.length + rule.definition.filter.agents.exclude.length)),
                includeSource: rules.some(rule => rule.definition.filter.source !== 'all'),
            });
            const visit = async (original: SessionFollowOriginalOccurrenceV1, evidence: SessionFollowRuleSourceEvidenceV1,
                terminalSourceMessage?: Readonly<{ localId: string; seq: number }>) => {
                check();
                const request = SessionFollowObserveSourceRoutesRequestV1Schema.parse({ v: 1, receiver: { kind: 'account' }, production: 'source',
                    ...('sourceMessage' in original ? { sourceMessage: original.sourceMessage }
                        : 'sourceTurn' in original ? { sourceTurn: original.sourceTurn } : { sourceRequests: original.sourceRequests }) });
                const path = SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.occurrenceRoutes.replace(':sourceSessionId', encodeURIComponent(sourceSessionId));
                const response = await authority.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(request), signal });
                check();
                if (!response.ok) return false;
                const parsed = SessionFollowObserveSourceRoutesResponseV1Schema.safeParse(await response.json());
                check();
                if (!parsed.success || !parsed.data.ok || parsed.data.sourceSessionId !== sourceSessionId
                    || parsed.data.receiverEvaluation?.ownerAccountId !== ownerAccountId
                    || parsed.data.receiverEvaluation.production !== 'source') return false;
                return input.onOccurrence({ sourceSessionId, production: parsed.data.receiverEvaluation.production, original, evidence,
                    currentFacts, personalFollowSuppressed: parsed.data.currentAccountFacts?.personalFollowSuppressed
                        ?? (session.viewer?.follow?.follows === false && session.viewer.follow.notificationLevel === 'none'),
                    isRepresentedInInbox: (policies, selectedRules = []) => {
                        check();
                        const selected = new Map(selectedRules.map(rule => [rule.ruleId, rule.ruleVersion]));
                        return classifyInboxSessionCandidate(buildSessionActivityAttention({ session, nowMs: Date.now(),
                            sessionMessages: sourceMessages, followRulePolicies: policies,
                            followRuleMatches: rules.filter(rule => selected.get(rule.ruleId) === rule.version)
                                .map(rule => ({ rule: { ruleId: rule.ruleId, ruleVersion: rule.version }, policy: rule.definition.policy })),
                            presentation: 'summary' })).section !== null;
                    },
                    ...(terminalSourceMessage ? { terminalSourceMessage } : {}),
                    ...(parsed.data.originalCreatedAt === undefined ? {} : { originalCreatedAt: parsed.data.originalCreatedAt }),
                });
            };
            const afterStateVersion = Math.min(...rules.map(rule => rule.sources?.find(source => source.sourceSessionId === sourceSessionId)?.delivered.agentStateVersion ?? 0));
            let sourceAvailable = true;
            if (session.agentStateVersion > afterStateVersion && session.agentStateVersion > 0) {
                let requests = listPendingSessionRequests(session, []);
                const projectedCount = (session.pendingPermissionRequestCount ?? 0) + (session.pendingUserActionRequestCount ?? 0);
                if (projectedCount > requests.length) {
                    // Recipient agentState is private. The incumbent pending owner reads its
                    // public originals and current completion facts, reusing this batched snapshot.
                    const details = await readPendingNavigationDetailsForAuthority(authority, session, {
                        signal, isCurrent: () => { check(); return true; },
                    });
                    check();
                    if (details.kind !== 'available' || details.requests.length < projectedCount) sourceAvailable = false;
                    else { requests = [...details.requests]; sourceMessages = details.messages; }
                }
                const originals: { requestId: string; createdAt: number; turnId?: string }[] = [];
                const requestEvidence: { requestId: string; evidence: SessionFollowRuleSourceEvidenceV1 }[] = [];
                for (const request of requests) {
                    if (readRunScopedExecutionPermissionRequestIdentity(request.id) || session.agentState?.requests?.[request.id]?.sidechainId) continue;
                    if (request.createdAt == null) { sourceAvailable = false; break; }
                    const event = resolveRequestFollowEventV1({ requestKind: resolvePendingRequestAttentionReasonV1({ kind: request.kind,
                        source: request.source }) === 'permission_required' ? 'permission' : 'user_action',
                        questionV1: request.questionV1, currentHandler: request.currentHandler });
                    const evidence = captureSemanticSessionFollowRuleSourceEvidenceV1({ serverId: input.lifetime.scope.serverId,
                        ownerAccountId, origin: session.origin ?? null, event });
                    if (!evidence) { sourceAvailable = false; break; }
                    originals.push({ requestId: request.id, createdAt: request.createdAt, ...(request.turnId ? { turnId: request.turnId } : {}) });
                    requestEvidence.push({ requestId: request.id, evidence });
                }
                if (sourceAvailable && originals.length) {
                    const sourceRequests = SessionFollowSourceRequestsV1Schema.safeParse({ agentStateVersion: session.agentStateVersion, requests: originals });
                    sourceAvailable = sourceRequests.success && await visit({ sourceSessionId, sourceRequests: sourceRequests.data,
                        requestEvidence }, requestEvidence[0]!.evidence);
                }
            }
            let afterSeq = Math.min(...rules.map(rule => {
                const delivered = rule.sources?.find(source => source.sourceSessionId === sourceSessionId)?.delivered;
                // Terminal originals settle only after this source's preceding original prefix.
                return Math.max(delivered?.transcriptSeq ?? 0, delivered?.readyEventSeq ?? 0);
            }));
            const terminal = new Map<string, Readonly<{ original: SessionFollowOriginalOccurrenceV1; evidence: SessionFollowRuleSourceEvidenceV1;
                terminalSourceMessage: Readonly<{ localId: string; seq: number }> }>>();
            while (sourceAvailable && afterSeq < session.seq) {
                check();
                const page = await fetchSessionMessagesPage({ sessionId: sourceSessionId, scope: 'all', afterSeq,
                    limit: SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1, signal, requestJson: async (path, requestSignal) => {
                        check();
                        const response = await authority.request(path, { signal: requestSignal });
                        check();
                        if (!response.ok) unavailable(response.status === 401 || response.status === 403 ? 'forbidden' : 'source_unavailable');
                        return response.json();
                    } });
                check();
                let scannedThroughSeq = afterSeq;
                for (const row of page.messages) {
                    if (row.seq > session.seq) break;
                    if (row.seq <= scannedThroughSeq) { sourceAvailable = false; break; }
                    const opened = await openSessionStoredContent(contentContext, row.content);
                    check();
                    if (opened.status !== 'ready') { sourceAvailable = false; break; }
                    const read = readOpenedSessionFollowOriginalV1({ sourceSessionId, serverId: input.lifetime.scope.serverId,
                        ownerAccountId, origin: session.origin ?? null, row, opened: opened.value });
                    if (read.status === 'unavailable') { sourceAvailable = false; break; }
                    if (read.status === 'occurrence' && !('sourceRequests' in read.occurrence)) {
                        // Message admission uses the same stored createdAt as this row.
                        // Turn admission uses the Turn's own terminal timestamp.
                        if ('sourceTurn' in read.occurrence) {
                            if (!row.localId) { sourceAvailable = false; break; }
                            terminal.set(read.occurrence.sourceTurn.id, { original: read.occurrence,
                                evidence: read.occurrence.evidence, terminalSourceMessage: { localId: row.localId, seq: row.seq } });
                        } else if (row.createdAt >= earliestInception && !await visit(read.occurrence, read.occurrence.evidence)) {
                            sourceAvailable = false;
                            break;
                        }
                    }
                    scannedThroughSeq = row.seq;
                }
                if (!sourceAvailable || page.hasMore === false) { afterSeq = scannedThroughSeq; break; }
                if (page.hasMore !== true || page.nextAfterSeq == null || page.nextAfterSeq <= afterSeq
                    || page.nextAfterSeq !== scannedThroughSeq) { sourceAvailable = false; break; }
                afterSeq = page.nextAfterSeq;
            }
            if (sourceAvailable && afterSeq >= session.seq) for (const value of terminal.values()) {
                if (!await visit(value.original, value.evidence, value.terminalSourceMessage)) break;
            }
        }
    });
}

export async function submitSessionFollowPersonalReceiverProgress(input: ReceiverCapture & Readonly<{
    progress: Extract<SessionFollowPersonalProgressRequestV1, { evaluation: 'receiver' }>;
}>): Promise<SessionFollowPersonalProgressResponseV1> {
    return withReceiverAuthority(input, async (authority, check, signal) => {
        const progress = SessionFollowPersonalProgressRequestV1Schema.parse(input.progress);
        if (!('evaluation' in progress) || progress.evaluation !== 'receiver') unavailable('forbidden');
        const response = await authority.request(SESSION_FOLLOW_PERSONAL_PROGRESS_ROUTE_V1, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(progress), signal });
        check();
        if (!response.ok) unavailable(response.status === 401 || response.status === 403 ? 'forbidden' : 'personal_progress_unavailable');
        const value = SessionFollowPersonalProgressResponseV1Schema.parse(await response.json());
        check();
        return value;
    });
}
