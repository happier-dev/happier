import { afterEach, describe, expect, it, vi } from 'vitest';

// Third-party rendering is outside this listing contract; its streaming renderer is unused here.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    projectLegacySessionAccessCapabilitiesV1,
    type AccountEncryptionCurrentnessResponse,
    type SessionListQueryV1,
    type V2SessionRecord,
} from '@happier-dev/protocol';

import { fetchAndApplySessions } from '@/sync/engine/sessions/sessionSnapshot';
import {
    advanceOrdinarySessionListFrontier,
    EMPTY_ORDINARY_SESSION_LIST_FRONTIER,
} from '@/sync/engine/sessions/ordinarySessionListFrontier';
import { buildOrdinarySessionListHomeState } from '@/sync/domains/session/listing/ordinarySessionListHomeState';
import { createSessionListQueryHomeController } from '@/sync/domains/session/listing/sessionListQueryController';
import { resolveSessionListQueryPresentation } from '@/sync/domains/session/listing/sessionListIndexPresentation';
import { isSessionListQueryHomeCoverageComplete } from '@/sync/domains/session/listing/sessionListHomeObservation';
import { buildSessionListQueryKey } from '@/sync/domains/session/listing/sessionListQueryKey';
import { readAdmittedSessionReferenceCorpusOptions } from '@/voice/tools/actionImpl/admittedSessionReferenceCorpus';

import { resolveSessionListViewEmptyState } from './sessionListViewEmptyStateModel';
import { createSessionListViewFilterDefaults } from './search/sessionListViewFilters';
import { resetSessionListPaneRetentionForTests, retainSessionListPaneState } from './sessionListPaneRetention';

afterEach(() => resetSessionListPaneRetentionForTests());

const PLAIN_ACCOUNT_CURRENTNESS = {
    mode: 'plain',
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
} satisfies AccountEncryptionCurrentnessResponse;

const QUERY: SessionListQueryV1 = {
    v: 1,
    storage: 'active',
    includeInactive: true,
    scope: 'all_accessible',
    attention: 'any',
    audiences: [],
    tagIds: [],
    includeAttention: false,
};

const DEFAULTS = {
    ...createSessionListViewFilterDefaults(),
    scope: 'all_accessible',
    attention: 'any',
    homeServerIds: ['home-a'],
    audiences: [],
    tagIds: [],
    source: 'all',
    searchQuery: '',
} as const;

function readableRow(id: string): V2SessionRecord {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        metadata: JSON.stringify({ path: `/${id}`, host: 'test' }),
        metadataVersion: 1,
        agentState: JSON.stringify({}),
        agentStateVersion: 1,
        dataEncryptionKey: null,
        encryptionMode: 'plain',
        share: null,
        effectiveAccess: {
            v: 1,
            level: 'owner',
            sources: [{ kind: 'owner' }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }),
        },
        viewer: {
            latestFailureSeq: null,
            readState: { state: 'not_started' },
            relevance: { relevant: false, reasons: [] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            follow: { follows: false, notificationLevel: 'none' },
            notification: { level: 'none', source: 'preference' },
        },
        responsibleAccountId: null,
        responsibleAccount: null,
    };
}

/**
 * The server isolates each historical layout-0 share it cannot project for a
 * recipient and reports how many it withheld. The wire bodies below are exactly
 * what `/v2/sessions` and `/v2/sessions/query` return for such a recipient.
 */
function fetchPage(body: unknown, source: 'query' | 'ordinary') {
    return fetchAndApplySessions({
        serverId: 'home-a',
        source: source === 'query'
            ? { kind: 'query', body: QUERY, allowV1Fallback: false }
            : { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: false },
        credentials: { token: 'token-a', secret: 'secret' } as AuthCredentials,
        accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
        encryption: null,
        sessionDataKeys: new Map(),
        request: async () => Response.json(body),
        applySessions: () => {},
        log: { log: () => {} },
    });
}

function emptyState(presentation: ReturnType<typeof resolveSessionListQueryPresentation>, visibleSessionCount: number) {
    return resolveSessionListViewEmptyState({
        presentation,
        visibleSessionCount,
        filters: DEFAULTS,
        defaults: DEFAULTS,
        viewContext: { kind: 'global' },
        includeInactive: true,
        hasHiddenInactiveSessions: false,
    });
}

describe('historical shares withheld by the Home', () => {
    it('never presents a strict query that withheld a historical share as an authoritative empty list', async () => {
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: () => fetchPage({
                sessions: [],
                nextCursor: null,
                hasNext: false,
                attentionNextCursor: null,
                attentionHasNext: false,
                metadataUpgradeRequiredCount: 1,
            }, 'query'),
        });
        await controller.update({ query: QUERY, selected: true, online: true, supported: true });
        const state = controller.getSnapshot();

        expect(state.metadataUpgradeRequiredCount).toBe(1);
        // Every page was read: pagination is exhausted, the corpus is still not whole.
        const coverageComplete = isSessionListQueryHomeCoverageComplete({
            state,
            requestedQueryKey: buildSessionListQueryKey('home-a', QUERY),
        });
        expect(coverageComplete).toBe(false);
        retainSessionListPaneState({
            storageKind: 'all',
            sourceScopeKey: 'account-a',
            queryMembershipActive: true,
            referenceCorpusActive: true,
            paneState: {
                summary: { sessionsReady: true, sessionCount: 0 },
                visibleSessionListIndex: [],
                hasHiddenInactiveSessions: false,
                folderFeatureEnabledServerIds: [],
                showLoading: false,
                showEmptyState: false,
                query: {
                    active: true,
                    statesByServerId: { 'home-a': state },
                    byServerId: { 'home-a': [] },
                    source: [],
                    coverageComplete,
                    loadNext: () => controller.loadNext(),
                    refresh: () => controller.refresh(),
                    retry: () => controller.retry(),
                },
            },
        });
        expect(readAdmittedSessionReferenceCorpusOptions({ ordinarySessionListMembershipByServerId: {} }))
            .toMatchObject({ coverage: 'incomplete', addresses: [] });
        const presentation = resolveSessionListQueryPresentation({
            selectedServerIds: ['home-a'],
            statesByServerId: { 'home-a': state },
            coverageComplete,
            retainedRowCount: 0,
        });
        expect(emptyState(presentation, 0)).toEqual({
            mode: 'empty',
            titleKey: 'sessionsList.queryHistoricalSharesWithheldTitle',
            descriptionKey: 'sessionsList.queryHistoricalSharesWithheldDescription',
            action: null,
        });
    });

    it('keeps the readable rows of an ordinary page and says historical shares are withheld', async () => {
        const result = await fetchPage({
            sessions: [readableRow('readable')],
            nextCursor: null,
            hasNext: false,
            metadataUpgradeRequiredCount: 2,
        }, 'ordinary');
        expect(result.sessionIds).toEqual(['readable']);

        const frontier = advanceOrdinarySessionListFrontier({
            previous: EMPTY_ORDINARY_SESSION_LIST_FRONTIER,
            continuation: null,
            result,
        });
        const state = buildOrdinarySessionListHomeState({
            serverId: 'home-a',
            requestedQueryKey: 'ordinary-key',
            sessionIds: result.sessionIds,
            observation: { phase: 'ready', lastSuccessAt: 1 },
            lifecycle: {
                serverId: 'home-a',
                hasFetchedSnapshot: true,
                fetchInFlight: false,
                fetchMoreInFlight: false,
                frontier,
            },
            online: true,
        });
        expect(state.metadataUpgradeRequiredCount).toBe(2);

        const presentation = resolveSessionListQueryPresentation({
            selectedServerIds: ['home-a'],
            statesByServerId: { 'home-a': state },
            coverageComplete: isSessionListQueryHomeCoverageComplete({ state, requestedQueryKey: 'ordinary-key' }),
            retainedRowCount: 1,
        });
        expect(emptyState(presentation, 1)).toEqual({
            mode: 'status',
            titleKey: 'sessionsList.queryHistoricalSharesWithheldTitle',
            descriptionKey: 'sessionsList.queryHistoricalSharesWithheldDescription',
            action: null,
        });
    });

    it('clears the limitation once a refresh no longer withholds anything', async () => {
        const withheld = await fetchPage({ sessions: [], nextCursor: null, hasNext: false, metadataUpgradeRequiredCount: 1 }, 'ordinary');
        const afterMigration = await fetchPage({ sessions: [readableRow('migrated')], nextCursor: null, hasNext: false }, 'ordinary');
        const first = advanceOrdinarySessionListFrontier({ previous: EMPTY_ORDINARY_SESSION_LIST_FRONTIER, continuation: null, result: withheld });
        const replaced = advanceOrdinarySessionListFrontier({ previous: first, continuation: null, result: afterMigration });
        expect(first.metadataUpgradeRequiredCount).toBe(1);
        expect(replaced.metadataUpgradeRequiredCount).toBe(0);
    });

    it('explains historical metadata omissions while retaining a real continuation', async () => {
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: () => fetchPage({
                sessions: [readableRow('readable')],
                nextCursor: 'cursor_v1_readable',
                hasNext: true,
                attentionNextCursor: null,
                attentionHasNext: false,
                metadataUpgradeRequiredCount: 1,
            }, 'query'),
        });
        await controller.update({ query: QUERY, selected: true, online: true, supported: true });
        const state = controller.getSnapshot();
        expect(state.hasNext).toBe(true);
        const presentation = resolveSessionListQueryPresentation({
            selectedServerIds: ['home-a'],
            statesByServerId: { 'home-a': state },
            coverageComplete: isSessionListQueryHomeCoverageComplete({
                state, requestedQueryKey: buildSessionListQueryKey('home-a', QUERY),
            }),
            retainedRowCount: 1,
        });
        expect(emptyState(presentation, 1)).toEqual({
            mode: 'status',
            titleKey: 'sessionsList.queryHistoricalSharesWithheldTitle',
            descriptionKey: 'sessionsList.queryHistoricalSharesWithheldDescription',
            action: 'load_more',
        });
    });

    it('preserves historical metadata omissions observed only in the active supplement', async () => {
        const result = await fetchAndApplySessions({
            serverId: 'home-a',
            credentials: { token: 'token-a', secret: 'secret' } as AuthCredentials,
            accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
            encryption: null,
            sessionDataKeys: new Map(),
            includeActiveSessionRows: true,
            request: async (path) => Response.json(path.startsWith('/v2/sessions/active')
                ? { sessions: [], nextCursor: null, hasNext: false, metadataUpgradeRequiredCount: 1 }
                : { sessions: [readableRow('readable')], nextCursor: null, hasNext: false }),
            applySessions: () => {},
            log: { log: () => {} },
        });
        expect(result.sessionIds).toEqual(['readable']);
        expect(result.metadataUpgradeRequiredCount).toBe(1);
        expect(result.hasNext).toBe(false);
        expect(result.attentionHasNext).toBe(false);
    });
});
