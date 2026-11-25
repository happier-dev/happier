import * as React from 'react';
import { Dimensions } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { ArtifactReadBatchHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ReviewListRequestV1Schema, type ReviewListItemV1, type ReviewListRequestV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import '@/sync/ops/actions/defaultActionExecutor';
import { WorkspaceRouteBody } from '@/app/(app)/reviews';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { reportCollectionLayout } from '@/dev/testkit/harness/collectionLayoutHarness';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { encodeBase64 } from '@/encryption/base64';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storageStore';
import { getReviewListSnapshot, reviewListKey } from '@/sync/store/domains/reviews/list';
import { sync } from '@/sync/sync';
import { t } from '@/text';

// Native rendering and HTTP are boundaries; query admission, decryption, filtering and paging remain real.
vi.mock('react-native', async () => {
    const lists = await import('@/dev/testkit/mocks/virtualizedList');
    return (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        ...lists.createCapturingFlatListMock().module,
        ...lists.createCapturingSectionListMock().module,
    });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/components/ui/popover', async original => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(original));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/reviews' }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
afterEach(async () => { await homes.reset(); vi.restoreAllMocks(); });

describe('mounted encrypted Review candidate paging', () => {
    it('keeps sparse loaded title matches explicit and cancels the next candidate page when demand leaves', async () => {
        vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 900, scale: 1, fontScale: 1 });
        const serverUrl = 'https://encrypted-review-candidates.example';
        const secret = new Uint8Array(32).fill(37);
        const credentials = { token: createAccountTokenForTests('alice'), secret: encodeBase64(secret, 'base64url') };
        const serverId = await homes.addHome({ name: 'Encrypted Reviews', serverUrl, accountId: 'alice', credentials, accountEncryptionMode: 'e2ee' });
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
        const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', credentials, request: homes.request });
        await sync.awaitBootstrapForegroundAcquisition();
        const encryption = await Encryption.create(secret);
        const rows: ReviewListItemV1[] = [];
        const ciphertexts = new Map<string, string>();
        const candidates = [
            ['earlier', 'Unrelated cleanup'], ['matching', 'Needle in captured changes'], ['retired', 'Needle from retired demand'],
        ] as const;
        for (const [index, [reviewId, title]] of candidates.entries()) {
            const key = new Uint8Array(32).fill(41 + index);
            const codec = new ArtifactEncryption(key);
            const header = await codec.encryptHeader({ kind: REVIEW_ARTIFACT_KIND_V1, v: 1, reviewId, title });
            ciphertexts.set(reviewId, header);
            homes.artifacts(serverId).replaceStoredRow({ id: reviewId, ownerAccountId: 'alice', access: 'owner',
                publicAudience: 'none', encryptionMode: 'e2ee', headerVersion: 1, bodyVersion: 1, seq: 1,
                createdAt: 1, updatedAt: 1, dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key)),
                header, body: await codec.encryptBody({ body: JSON.stringify({ v: 1, rounds: [] }) }) });
            rows.push({ reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
                state: 'completed', currentRoundOrdinal: 1, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2,
                counts: { total: 1, needsDecision: 1 } });
        }
        expect(JSON.stringify(homes.artifacts(serverId).list())).not.toContain('Needle');
        let releaseHeld!: () => void;
        const held = new Promise<void>(resolve => { releaseHeld = resolve; });
        let heldSignal: AbortSignal | null | undefined;
        const requests: ReviewListRequestV1[] = [];
        const page = (row: ReviewListItemV1, cursor: string | null) => ({ items: [{ ...row,
            needsYou: { reviewId: row.reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: false,
                requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false } }], cursor });
        homes.answer(serverId, 'POST /v1/reviews/list', { select: (input, request) => {
            const query = ReviewListRequestV1Schema.parse(input);
            requests.push(query);
            if (!query.cursor) return { body: page(rows[0]!, 'next') };
            if (query.cursor === 'next') return { body: page(rows[1]!, 'retiring') };
            heldSignal = request.signal;
            return { body: page(rows[2]!, null), respondAfter: held };
        } });
        // Observe the real crypto operation without replacing it. Counts are demanded envelopes, not a runtime cap.
        const opens = vi.spyOn(ArtifactEncryption.prototype, 'decryptHeaderRaw');
        const bodyOpens = vi.spyOn(ArtifactEncryption.prototype, 'decryptBody');
        const openedTitles = () => opens.mock.calls.map(([ciphertext]) => [...ciphertexts]
            .find(([, stored]) => stored === ciphertext)?.[0]).filter(id => id !== undefined);
        const before = homes.requests.length;
        const restorePopoverGlobals = withPopoverWebGlobals();
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active presentationActive><WorkspaceRouteBody /></PluginSurfaceFocusEligibilityProvider>);
        try {
            await reportCollectionLayout(screen, 'reviews:list');
            await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Unrelated cleanup'));
            expect(openedTitles()).toEqual(['earlier']);
            await screen.pressByTestIdAsync('reviews:search-toggle');
            await act(async () => { screen.changeTextByTestId('reviews:search', 'Needle'); });
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('reviews:row:earlier')).toBeNull());
            expect(screen.findHostByTestId('reviews:row:matching')).toBeNull();
            expect(screen.getTextContent()).toContain(t('ui.pluginUi.empty'));
            expect(screen.findHostByTestId('reviews:list:continuation:more')).not.toBeNull();
            expect(requests).toEqual([{ limit: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 }]);
            expect(openedTitles()).toEqual(['earlier']);
            await screen.pressByTestIdAsync('reviews:list:continuation:more');
            await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Needle in captured changes'));
            expect(screen.findHostByTestId('reviews:row:earlier')).toBeNull();
            expect(screen.findHostByTestId('reviews:row:matching')).not.toBeNull();
            expect(requests).toEqual([{ limit: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 }, { limit: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1, cursor: 'next' }]);
            expect(openedTitles()).toEqual(['earlier', 'matching']);
            let continuation: Promise<void> | undefined;
            await act(async () => {
                const button = screen.findAll(node => node.props.testID === 'reviews:list:continuation:more'
                    && typeof node.props.onPress === 'function')[0];
                continuation = button!.props.onPress();
            });
            await waitForHomeGovernance(() => expect(heldSignal).toBeDefined());
            await screen.unmount();
            expect(heldSignal?.aborted).toBe(true);
            await act(async () => { releaseHeld(); await continuation; });
            const snapshot = getReviewListSnapshot(reviewListKey({ serverId, accountId: 'alice' }, { limit: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 }));
            expect(snapshot.items?.map(row => row.reviewId)).toEqual(['earlier', 'matching']);
            expect(snapshot.cursor).toBe('retiring');
            expect(storage.getState().artifacts.retired).toBeUndefined();
            expect(openedTitles()).toEqual(['earlier', 'matching']);
            expect(bodyOpens).not.toHaveBeenCalled();
            const reads = homes.requests.slice(before);
            expect(reads.filter(request => request.path === '/v1/artifacts/read').map(request => ArtifactReadBatchHttpInputV1Schema.parse(request.input)))
                .toEqual([{ artifactIds: ['earlier'], projection: 'headers' }, { artifactIds: ['matching'], projection: 'headers' }]);
            expect(reads.filter(request => request.path.startsWith('/v1/reviews/comments'))).toEqual([]);
            expect(requests.map(query => query.cursor ?? null)).toEqual([null, 'next', 'retiring']);
        } finally {
            releaseHeld();
            await screen.unmount();
            await connection.dispose();
            restorePopoverGlobals();
        }
    });
});
