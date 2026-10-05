import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewCommentV1, ReviewFindingsV2 } from '@happier-dev/protocol';

import { buildReviewCommentFixture, createDeferred, createRootLayoutFeaturesResponse, createSessionFixture, flushHookEffects, renderScreen, standardCleanup, storePlainReviewCommentFixture } from '@/dev/testkit';
import { serveActionHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { HomeCredentialMutationEvent } from '@/auth/storage/tokenStorage';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetReviewRunCommentsForTests, readReviewRunComments, subscribeReviewRunComments } from '@/sync/domains/reviews/comments/reviewRunComments';
import { clearBrowserRecords } from '@/sync/domains/state/browserRecordStorage';
import { loadPendingOutboxForSession } from '@/sync/domains/state/pendingOutboxPersistence';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Keep the card, credential binding, Action reads, Sync submit, and durable outbox real. Only
// native presentation, secure-storage notifications, HTTP/socket, and IndexedDB are boundaries.
const credentialObservers = vi.hoisted(() => new Set<(event: HomeCredentialMutationEvent) => void>());
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        subscribeHomeCredentialMutations: (observer) => {
            credentialObservers.add(observer);
            return () => { credentialObservers.delete(observer); };
        },
    });
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('expo-image', () => ({ Image: (props: Record<string, unknown>) => React.createElement('Image', props) }));
vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});
installDisconnectedServerSocketBoundary();

const SESSION_ID = 'review-submit-session';
const RUN_ID = 'review-submit-run';
const initialState = storage.getState();
let ReviewFindingsMessageCard!: typeof import('./ReviewFindingsMessageCard').ReviewFindingsMessageCard;
let disposeHomes: (() => void) | undefined;

const comment: ReviewCommentV1 = {
    ...buildReviewCommentFixture({ id: 'review-submit-comment', sessionId: SESSION_ID, runId: RUN_ID, state: 'open', serverRevision: 7 }),
    workspace: { machineId: 'machine-1', path: '/repo' },
    findingId: 'finding-1',
    reviewTriageStatus: 'accept',
};
const payload: ReviewFindingsV2 = {
    runRef: { runId: RUN_ID, callId: 'review-submit-call', backendId: 'claude', retentionPolicy: 'resumable' },
    summary: 'A correctness issue.',
    overviewMarkdown: 'A correctness issue.',
    generatedAtMs: 1,
    findings: [{ id: 'finding-1', title: 'Fix the issue', severity: 'high', category: 'correctness', summary: 'Preserve the captured Account.', filePath: 'src.ts', startLine: 1 }],
    questions: [],
    assumptions: [],
};

beforeAll(async () => {
    await loadSyncSingletonForTests();
    ({ ReviewFindingsMessageCard } = await import('./ReviewFindingsMessageCard'));
}, 600_000);

beforeEach(async () => {
    storage.setState(initialState, true);
    await clearBrowserRecords();
    await prepareSessionDraftPersistenceStorage();
});

afterEach(() => {
    standardCleanup();
    sync.disconnectServer();
    disposeHomes?.();
    disposeHomes = undefined;
    resetReviewRunCommentsForTests();
    invalidateAccountEncryptionModeCache();
    vi.restoreAllMocks();
});

async function setupHomes(focusReview: boolean, beforeReviewResponse?: (read: number) => void | Promise<void>) {
    let reviewReads = 0;
    const served = await serveActionHomes({
        homes: focusReview ? [
            { key: 'other', serverUrl: 'https://review-submit-other.test', accountId: 'other-account' },
            { key: 'review', serverUrl: 'https://review-submit-home.test', accountId: 'account-1' },
        ] : [
            { key: 'review', serverUrl: 'https://review-submit-home.test', accountId: 'account-1' },
            { key: 'other', serverUrl: 'https://review-submit-other.test', accountId: 'other-account' },
        ],
        route: (request: ServedHomeRequest) => {
            if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (request.path === '/v1/reviews/comments' && request.method === 'GET') {
                return (async () => {
                    await beforeReviewResponse?.(++reviewReads);
                    return Response.json({ items: [storePlainReviewCommentFixture(comment)], cursor: null });
                })();
            }
            if (request.path.endsWith('/pending') && request.method === 'POST') {
                // An interrupted network keeps the real owner's durable enqueue available to
                // inspect; this is not an injected submit/persistence result.
                throw new TypeError('Network unavailable');
            }
            return undefined;
        },
    });
    disposeHomes = served.dispose;
    // The exact pane Session is loaded, while both Home lists contain its bare id. The legacy
    // bare-id resolver correctly refuses that ambiguity; the pane's explicit target must survive.
    storage.getState().applySessions([createSessionFixture({
        id: SESSION_ID, serverId: served.homes.review!.id, active: true, pendingVersion: 2,
    })]);
    if (!focusReview) storage.setState({ ordinarySessionListMembershipByServerId: {
        [served.homes.review!.id]: [SESSION_ID], [served.homes.other!.id]: [SESSION_ID],
    } });
    const scope = { serverId: served.homes.review!.id, accountId: 'account-1' };
    const screen = await renderScreen(<ReviewFindingsMessageCard
        serverId={scope.serverId} payload={payload} sessionId={SESSION_ID} canSendMessages presentation="page"
    />);
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(screen.findByTestId('review-findings-publish-accepted')?.props.disabled).toBe(false);
    });
    return { ...served, scope, screen };
}

describe('ReviewFindingsMessageCard final submit Account custody', () => {
    it('persists Implement fixes only in the qualified nonfocused Home outbox', async () => {
        const { homes, scope, screen, requests } = await setupHomes(false);
        const otherScope = { serverId: homes.other!.id, accountId: 'other-account' };
        await act(async () => { await screen.pressByTestIdAsync('review-findings-publish-accepted'); });

        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(await loadPendingOutboxForSession(SESSION_ID, scope)).toEqual([
                expect.objectContaining({ text: expect.stringContaining('review-submit-comment'), operation: 'enqueue' }),
            ]);
        });
        expect(await loadPendingOutboxForSession(SESSION_ID, otherScope)).toEqual([]);
        for (const request of requests.filter((request) => request.path.endsWith('/pending') && request.method === 'POST')) {
            expect(request).toMatchObject({ home: 'review', accountId: 'account-1' });
        }
    });

    it('refuses a credential retirement after the final review read without dispatch or a replacement Account write', async () => {
        const { homes, scope, screen, requests, switchAccount } = await setupHomes(true);
        const target = { scope, sessionId: SESSION_ID, runId: RUN_ID };
        const replacementScope = { serverId: scope.serverId, accountId: 'replacement-account' };
        let retiredAfterRead = false;
        const unsubscribe = subscribeReviewRunComments(target, () => {
            if (retiredAfterRead || readReviewRunComments(target).status !== 'loaded') return;
            retiredAfterRead = true;
            // The real comment owner publishes after its scoped Action read has succeeded, before
            // Implement's await resumes. Deliver the secure-storage boundary's credential event
            // synchronously here so this tests the final admission gap rather than a read refusal.
            switchAccount('review', replacementScope.accountId);
            storage.setState({ settingsScope: replacementScope, profileScope: replacementScope });
            const event: HomeCredentialMutationEvent = {
                kind: 'credentials_set', serverId: scope.serverId, serverUrl: homes.review!.serverUrl,
                credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: replacementScope.accountId })).toString('base64url')}.signature` },
            };
            for (const observer of [...credentialObservers]) observer(event);
        });
        const submit = vi.spyOn(sync, 'submitMessage'); // Observation only: executes real submit if called.
        try {
            await act(async () => { await screen.pressByTestIdAsync('review-findings-publish-accepted'); });
            await flushHookEffects({ cycles: 12, turns: 4 });
            expect(retiredAfterRead).toBe(true);
            expect(readReviewRunComments(target).comments[0]?.reviewTriageStatus).toBe('accept');
            expect(submit).not.toHaveBeenCalled();
            expect(await loadPendingOutboxForSession(SESSION_ID, scope)).toEqual([]);
            expect(await loadPendingOutboxForSession(SESSION_ID, replacementScope)).toEqual([]);
            expect(requests.filter((request) => request.path.endsWith('/pending') && request.method === 'POST')).toEqual([]);
        } finally {
            unsubscribe();
        }
    });

    it('refuses Implement when the pane becomes read-only while its final review read is pending', async () => {
        const finalReadStarted = createDeferred<void>();
        const releaseFinalRead = createDeferred<void>();
        const { scope, screen, requests } = await setupHomes(true, (read) => {
            if (read !== 2) return;
            finalReadStarted.resolve();
            return releaseFinalRead.promise;
        });
        const submit = vi.spyOn(sync, 'submitMessage');
        await act(async () => { await screen.pressByTestIdAsync('review-findings-publish-accepted'); });
        await finalReadStarted.promise;
        await act(async () => {
            screen.update(<ReviewFindingsMessageCard
                serverId={scope.serverId} payload={payload} sessionId={SESSION_ID} canSendMessages={false} presentation="page"
            />);
        });
        await act(async () => { releaseFinalRead.resolve(); });
        await flushHookEffects({ cycles: 12, turns: 4 });
        expect(readReviewRunComments({ scope, sessionId: SESSION_ID, runId: RUN_ID }).comments[0]?.reviewTriageStatus).toBe('accept');
        expect(submit).not.toHaveBeenCalled();
        expect(await loadPendingOutboxForSession(SESSION_ID, scope)).toEqual([]);
        expect(requests.filter((request) => request.path.endsWith('/pending') && request.method === 'POST')).toEqual([]);
    });
});
