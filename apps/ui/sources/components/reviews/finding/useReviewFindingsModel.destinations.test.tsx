import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import '@/sync/ops/actions/defaultActionExecutor';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { buildReviewCommentFixture, storePlainReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { storage } from '@/sync/domains/state/storage';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { createNewSessionComposerDocumentOwner } from '@/components/sessions/composer/newSessionComposerDocumentOwner';
import { useReviewFindingsModel } from './useReviewFindingsModel';

const effects = vi.hoisted(() => ({ copy: vi.fn<(text: string) => Promise<boolean>>(), push: vi.fn() }));
// OS clipboard, navigation and authenticated HTTP are the boundaries. Policy, Review Apply and drafts stay real.
vi.mock('expo-clipboard', () => ({ setStringAsync: effects.copy }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: effects.push } }).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const reviewId = 'prepared-destination-review';
const root = buildReviewCommentFixture({ id: 'accepted-comment', reviewId, accountId: 'alice', findingIdentity: 'a'.repeat(64),
    reviewTriageStatus: 'accept', body: 'Current accepted explanation.', findingId: 'finding',
    finding: { id: 'finding', title: 'Accepted defect', summary: 'Stale finding projection.', severity: 'high', category: 'correctness' } });
const review: DecryptedArtifact = { id: reviewId, title: 'Prepared Review', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Prepared Review' },
    body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: ['first'], runs: [] }] }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
let serverId = '';
beforeEach(async () => {
    Platform.OS = 'ios';
    await homes.reset();
    serverId = await homes.addHome({ name: 'Prepared Review', serverUrl: 'https://review-prepared.test', accountId: 'alice', currentAccount: true });
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://review-prepared.test', generation: 1 });
    storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
    homes.artifacts(serverId).replaceStoredRow(createPlainArtifactHttpFixture(review, 'alice'));
    homes.answer(serverId, 'GET /v1/reviews/comments', { body: { items: [storePlainReviewCommentFixture(root)], cursor: null } });
    effects.copy.mockReset().mockResolvedValue(true);
    effects.push.mockClear();
    Platform.OS = 'ios';
});
afterEach(async () => {
    await standardCleanup();
    resetSessionDraftRepositoryForTests();
    publishAppliedActiveServerRuntimeAvailability(false);
    await homes.reset();
    vi.unstubAllGlobals();
});

async function mountModel(canAct = true) {
    let bound = false;
    const hook = await renderHook(() => {
        const { binding } = useServerCredentialAccountScopeBinding(serverId);
        bound = binding !== null;
        return useReviewFindingsModel({ members: [], reviewerCount: 1,
            record: { round: { reviewId, roundOrdinal: 1, state: 'completed', reviewerIds: ['first'] }, comments: [root] },
            serverId, scope: binding?.scope ?? null, accountLifetime: binding, sessionId: null,
            canAct, pending: {}, onDecideComment: async () => false });
    });
    await waitForHomeGovernance(() => expect(bound).toBe(true));
    return hook;
}

it('copies the canonical current accepted prompt without a Session and opens the identical prompt in an editable New Session draft', async () => {
    const hook = await mountModel();
    try {
        let copied = false;
        await act(async () => { copied = await hook.getCurrent().implement.copyPrompt(); });
        expect(copied, JSON.stringify({ error: hook.getCurrent().error, requests: homes.requests.map(request => ({ method: request.method, path: request.path })) })).toBe(true);
        const prompt = effects.copy.mock.calls[0]?.[0];
        expect(prompt).toContain('Current accepted explanation.');
        expect(prompt).not.toContain('Stale finding projection.');
        expect(effects.push).not.toHaveBeenCalled();
        await act(async () => { await hook.getCurrent().implement.runInNewSession(); });
        const navigation = effects.push.mock.calls[0]?.[0];
        expect(navigation).toMatchObject({ pathname: '/new', params: { draftId: expect.any(String) } });
        const scope = captureActiveServerAccountScopeLifetime()!.scope;
        expect(createNewSessionComposerDocumentOwner({ scope,
            ref: { kind: 'newSession', instanceId: navigation.params.draftId } }).read().document.text).toBe(prompt);
        expect(homes.requests.some(request => request.path.includes('/messages'))).toBe(false);
    } finally { await hook.unmount(); }
});

it('honors the clipboard Action policy and does not open an empty draft when acceptance changed at the owner', async () => {
    await homes.setActionPolicy(serverId, 'clipboard.write', 'ui', 'off');
    const hook = await mountModel();
    try {
        await act(async () => { expect(await hook.getCurrent().implement.copyPrompt()).toBe(false); });
        expect(effects.copy).not.toHaveBeenCalled();
        homes.artifacts(serverId).replaceStoredRow(createPlainArtifactHttpFixture(review, 'alice'));
        homes.answer(serverId, 'GET /v1/reviews/comments', { body: {
            items: [storePlainReviewCommentFixture({ ...root, reviewTriageStatus: 'defer', serverRevision: 2 })], cursor: null } });
        await act(async () => { await hook.getCurrent().implement.runInNewSession(); });
        expect(effects.push).not.toHaveBeenCalled();
    } finally { await hook.unmount(); }
});

it('starts the browser clipboard promise in the gesture and supplies only the prepared prompt', async () => {
    Platform.OS = 'web';
    await homes.reset();
    serverId = await homes.addHome({ name: 'Prepared Review Web', serverUrl: 'https://review-prepared-web.test', accountId: 'alice', currentAccount: true });
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://review-prepared-web.test', generation: 1 });
    storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
    homes.artifacts(serverId).replaceStoredRow(createPlainArtifactHttpFixture(review, 'alice'));
    homes.answer(serverId, 'GET /v1/reviews/comments', { body: { items: [storePlainReviewCommentFixture(root)], cursor: null } });
    class ClipboardItemBoundary {
        constructor(readonly content: Readonly<Record<string, Promise<Blob>>>) {}
    }
    const copied: string[] = [];
    const write = vi.fn(async (items: readonly ClipboardItemBoundary[]) => {
        copied.push(await (await items[0]!.content['text/plain']!).text());
    });
    vi.stubGlobal('ClipboardItem', ClipboardItemBoundary);
    vi.stubGlobal('navigator', { clipboard: { write } });
    const hook = await mountModel();
    try {
        await act(async () => {
            const result = hook.getCurrent().implement.copyPrompt();
            expect(write).toHaveBeenCalledOnce();
            expect(copied).toEqual([]);
            expect(await result).toBe(true);
        });
        expect(copied[0]).toContain('Current accepted explanation.');
        expect(effects.copy).not.toHaveBeenCalled();
    } finally { await hook.unmount(); }
});

it('lets a readable Review copy accepted findings without permission to change its decisions', async () => {
    const hook = await mountModel(false);
    try {
        let copied = false;
        await act(async () => { copied = await hook.getCurrent().implement.copyPrompt(); });
        expect(copied, JSON.stringify({ error: hook.getCurrent().error, requests: homes.requests.map(request => ({ method: request.method, path: request.path })) })).toBe(true);
        expect(effects.copy.mock.calls[0]?.[0]).toContain('Current accepted explanation.');
        expect(effects.push).not.toHaveBeenCalled();
    } finally { await hook.unmount(); }
});
