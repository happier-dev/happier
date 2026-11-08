import { evaluateFollowRulePreviewV1, type FollowRulePreviewCandidateV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRulePreviewV1';
import { equalFollowRuleReceiverV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { FollowReceiverRefV1Schema } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import type { FollowPreviewActionInputV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { projectSessionListFilterAfterHomeQueryV1, projectSessionListFilterHomeQueriesV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterQueryV1';
import { canSessionListFilterIncludeRunsV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SESSION_LIST_PAGE_MAX_LIMIT, supportsSessionListProjectSelectionV1 } from '@happier-dev/protocol/sessions/listing/query';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storage';
import { findSessionListLookupSession } from '@/sync/domains/session/listing/sessionListLookupState';
import { fetchSessionListQueryPageForHome } from '@/sync/domains/session/listing/sessionListQueryRuntime';
import { buildSessionListRowFilterFacts, buildWorkflowRunFilterFacts } from '@/sync/domains/session/listing/sessionListWorkFilter';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';
import { readProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { createSessionProjectKeyResolverV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { listAllWorkflowRuns } from '@/sync/domains/workflows/workflowRunListActions';
import type { SessionFollowRulesSnapshot } from './sessionFollowRulesApi';

/** The listing owner proves Session membership; the shared filter owns local facts. */
export async function previewSessionFollowRule(input: Readonly<{
    serverId: string;
    accountId: string;
    request: FollowPreviewActionInputV1;
    rules: SessionFollowRulesSnapshot;
    signal: AbortSignal;
    assertCurrent(): void;
    sourceSession?: Parameters<typeof buildSessionListRowFilterFacts>[0];
}>) {
    const receiver = FollowReceiverRefV1Schema.parse(input.request.receiver);
    const rules = input.rules;
    input.assertCurrent();
    let state = getStorage().getState();
    const scope = state.profileScope;
    const readable = rules.status === 'ready' && rules.accountId === input.accountId && state.isDataReady
        && scope?.accountId === input.accountId && areServerProfileIdentifiersEquivalent(scope.serverId, input.serverId);
    const candidates: FollowRulePreviewCandidateV1[] = [];
    let coverage: 'complete' | 'partial' | 'unavailable' = readable ? 'complete' : 'unavailable';
    const filter = input.request.filter;
    if (readable && !input.sourceSession && ((canSessionListFilterIncludeRunsV1(filter) && filter.underSessionId === undefined)
        || filter.homeServerIds.some(serverId => !areServerProfileIdentifiersEquivalent(serverId, input.serverId)))) coverage = 'partial';
    if (readable) {
        const admitted = new Map<string, () => boolean>();
        if (filter.show !== 'runs' && !input.sourceSession) {
            const features = filter.projects && (filter.projects.include.length || filter.projects.exclude.length)
                ? await getServerFeaturesSnapshot({ serverId: input.serverId, signal: input.signal }) : null;
            input.assertCurrent();
            for (const home of projectSessionListFilterHomeQueriesV1(filter, { storage: 'active', includeInactive: true,
                mountedHomeServerIds: [input.serverId], limit: SESSION_LIST_PAGE_MAX_LIMIT, includeAttention: false,
                // A selected Project asks for every key its Sessions may carry (owner 11-08).
                workspaceRefs: readProjectAccountWorkspaceRefs(getStorage().getState()),
                projectFacet: features?.status === 'ready' && supportsSessionListProjectSelectionV1(features.features) ? 'query' : 'local' })) {
                let cursor: string | undefined;
                let attentionCursor: string | undefined;
                let previousPage: Awaited<ReturnType<typeof fetchSessionListQueryPageForHome>> | undefined;
                const seen = new Set<string>();
                for (;;) {
                    input.assertCurrent();
                    let page = await fetchSessionListQueryPageForHome(home.serverId, { membership: 'rowOnly', hydration: 'required',
                        candidateStartedBy: { selection: filter.startedBy, viewerAccountId: input.accountId },
                        source: { kind: 'query', body: { ...home.query, cursor, attentionCursor }, allowV1Fallback: false },
                        cursor, attentionCursor, signal: input.signal });
                    input.assertCurrent();
                    if (!page.current) throw new Error('scope-retired');
                    if (previousPage) page = attentionCursor
                        ? { ...page, nextCursor: previousPage.nextCursor, hasNext: previousPage.hasNext }
                        : { ...page, attentionNextCursor: previousPage.attentionNextCursor, attentionHasNext: previousPage.attentionHasNext };
                    previousPage = page;
                    for (const sessionId of page.sessionIds) admitted.set(sessionId, () => page.isSessionCurrent?.(sessionId) !== false);
                    if (page.metadataUpgradeRequiredCount) coverage = 'partial';
                    const nextCursor = page.hasNext ? page.nextCursor : null;
                    const nextAttentionCursor = !nextCursor && page.attentionHasNext ? page.attentionNextCursor : null;
                    if (!nextCursor && !nextAttentionCursor) {
                        if (page.hasNext || page.attentionHasNext) coverage = 'partial';
                        break;
                    }
                    const key = JSON.stringify([nextCursor ? 'ordinary' : 'attention', nextCursor ?? nextAttentionCursor]);
                    if (seen.has(key)) { coverage = 'partial'; break; }
                    seen.add(key);
                    cursor = nextCursor ?? undefined;
                    attentionCursor = nextAttentionCursor ?? undefined;
                }
            }
        }
        state = getStorage().getState();
        if (state.profileScope?.accountId !== input.accountId
            || !areServerProfileIdentifiersEquivalent(state.profileScope.serverId, input.serverId)) throw new Error('scope-retired');
        const nowMs = Date.now();
        const workspaceRefs = readProjectAccountWorkspaceRefs(state);
        const sessionProjectKeyResolver = createSessionProjectKeyResolverV1(workspaceRefs, workspaceRefResolutionContextV1());
        const seen = new Set<string>();
        const add = (row: Parameters<typeof buildSessionListRowFilterFacts>[0]) => {
            if (!row || row.archivedAt != null || !isUserFacingSession(row) || seen.has(row.id)) return;
            seen.add(row.id);
            const readableRow = isSessionContentReadable(readSessionContentAvailability(row))
                ? row : { ...row, metadata: null, ownerMetadataView: null, metadataUnavailable: true };
            candidates.push({ source: { kind: 'session', sessionId: row.id }, facts: buildSessionListRowFilterFacts(
                readableRow, input.serverId, { nowMs, viewerAccountId: input.accountId, workspaceRefs, sessionProjectKeyResolver,
                    workspaceRefsServerId: state.profileScope?.serverId,
                    includeStatus: Boolean(input.request.filter.statuses?.length), includeSource: input.request.filter.source !== 'all',
                    tagIds: state.sessionOrganizationTagAssignmentsBySessionKey[buildSessionOrganizationSessionKey(input.serverId, row.id)]?.tagIds,
                }),
            });
        };
        if (input.sourceSession) add(input.sourceSession);
        for (const [sessionId, isCurrent] of admitted) {
            if (!isCurrent()) { coverage = 'partial'; continue; }
            const row = findSessionListLookupSession(state, { serverId: input.serverId, sessionId })?.session;
            if (!row) { coverage = 'partial'; continue; }
            add(row);
        }
        if (!input.sourceSession && canSessionListFilterIncludeRunsV1(filter) && filter.underSessionId !== undefined) {
            try {
                const runs = await listAllWorkflowRuns({ filter: { underSessionId: filter.underSessionId }, signal: input.signal });
                input.assertCurrent();
                for (const run of runs.runs) candidates.push({ source: { kind: 'workflow_run', runId: run.id },
                    facts: buildWorkflowRunFilterFacts(run, input.serverId, input.accountId, true) });
            } catch {
                input.assertCurrent();
                coverage = 'partial';
            }
        } else if (!input.sourceSession && canSessionListFilterIncludeRunsV1(filter)) {
            for (const [key, row] of Object.entries(state.workflowRunsById)) {
                if (key !== workflowRunStoreKey(row.id, scope) || !row.summary) continue;
                candidates.push({ source: { kind: 'workflow_run', runId: row.id }, facts: buildWorkflowRunFilterFacts(row.summary, input.serverId, input.accountId) });
            }
        }
    }
    input.assertCurrent();
    return evaluateFollowRulePreviewV1({ filter: filter.show === 'sessions' && !input.sourceSession
        ? projectSessionListFilterAfterHomeQueryV1(filter, input.serverId) : filter, candidates,
        coverage, otherRules: input.sourceSession || rules.status !== 'ready' ? [] : rules.rules
            .filter(rule => rule.receiver.kind === 'session' && !equalFollowRuleReceiverV1(rule.receiver, receiver))
            .map(rule => ({ ruleId: rule.ruleId, enabled: rule.definition.enabled, filter: rule.definition.filter })),
    });
}
