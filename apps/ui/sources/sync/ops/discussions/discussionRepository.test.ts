import { describe, expect, it, vi } from 'vitest';

import type {
    DiscussionCreateResultV1,
    DiscussionOpenedMessageV1,
    DiscussionOpenedSummaryV1,
} from '@happier-dev/protocol/discussions/actions';
import type { DiscussionDraftSubmission } from './discussionRepository';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { DiscussionListResultV1Schema, DiscussionDetailsResultV1Schema,
    DiscussionReadResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createDiscussionActionAdapter, readDiscussionAttentionPage, type DiscussionClientOutcome } from '@/sync/api/discussions/discussionActions';
import { Encryption } from '@/sync/encryption/encryption';
import { createResourceDataKey } from '@/sync/encryption/resourceDataKey';
import { resourceStoredContentContext } from '@/sync/encryption/resourceStoredContent';
import { sealSessionStoredContent } from '@happier-dev/sync-client';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { DiscussionCreateRequestV1Schema, type DiscussionCreateRequestV1, type DiscussionCreateResponseV1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionCreateResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DiscussionAccessGrantsListResponseV1Schema, DiscussionAccessGrantMutationResponseV1Schema, DiscussionLeaveResponseV1Schema } from '@happier-dev/protocol/discussions/access';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { DiscussionSummaryV1Schema } from '@happier-dev/protocol/discussions/models';
import { act, flushHookEffects, renderHook } from '@/dev/testkit';
import { useSyncExternalStore } from 'react';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { useDiscussionRepositorySnapshot } from './useDiscussionRepositorySnapshot';

import { createDiscussionRepository, selectDiscussionListSearch, selectDiscussionThreadAccessState, type DiscussionRepositoryClient } from './discussionRepository';
import { publishMountedDiscussionChanges } from '@/sync/domains/discussions/discussionChangeWatch';
import { fetchChanges } from '@/sync/api/session/apiChanges';
import { runSocketReconnectCatchUpViaChanges } from '@/sync/runtime/orchestration/socketReconnectViaChanges';
import { applyPlannedChangeActions } from '@/sync/runtime/orchestration/changesApplier';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    clearDiscussionRepositoryRegistryForTests,
    getDiscussionRepository,
} from './discussionRepositoryRegistry';

import { address, scope, summary, message, listResult, readResult, client } from './discussionRepository.testkit';

it('does not publish an empty ready thread from a summary before its first history read', async () => {
    const history = createDeferred<Response>();
    const requests: string[] = [];
    const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
        requests.push(path);
        return path.endsWith('/messages') ? history.promise
            : response({ discussion: storedSummary('discussion-a') });
    }) });
    const emptyReady: string[] = [];
    const leave = repository.subscribe(() => {
        const thread = repository.getSnapshot().threads['discussion-a'];
        if (thread?.status === 'ready' && thread.messages.length === 0) emptyReady.push(thread.summary!.id);
    });
    try {
        // Labels can demand a summary before the person opens its thread.
        await repository.refreshSummary('discussion-a');
        expect(emptyReady).toEqual([]);
        const opening = repository.refreshDiscussion('discussion-a');
        await vi.waitFor(() => expect(requests).toContain('/v1/discussions/discussion-a/messages'));
        expect(repository.getSnapshot().threads['discussion-a']?.status).toBe('loading');
        expect(emptyReady).toEqual([]);
        history.resolve(response({ messages: [storedMessage('discussion-a', 1)], hasMoreOlder: false, messageSeq: 1 }));
        await opening;
        expect(repository.getSnapshot().threads['discussion-a']).toMatchObject({ status: 'ready', messages: [{ seq: 1 }] });
    } finally { leave(); repository.clear(); }
});

it.each(['catch-up-pending', 'socket'] as const)('keeps Workflow-only %s wakes out of mounted attention while real changes and revocation remain fresh', async source => {
    const requests: string[] = [];
    let attentionChanged = false;
    let denied = false;
    const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
        requests.push(path);
        if (denied) return new Response(JSON.stringify({ error: 'discussion_read_denied' }), { status: 403 });
        return response({ discussions: attentionChanged ? [{ discussion: storedSummary('discussion-a'),
            occurrences: [{ type: 'update', message: storedMessage('discussion-a', 1) }] }] : [],
            nextCursor: null, incomplete: false });
    }) });
    await repository.refreshAttention();
    const leave = repository.mount({ attention: true });
    try {
        requests.length = 0;
        for (let index = 0; index < 1_000; index++) publishHomeAccountChange(scope.serverId, [`workflow-run:run-${index}`], {
            source, changeKinds: ['account'],
        });
        await flushHookEffects();
        expect(requests).toEqual([]);
        for (const recovery of ['connected', 'snapshot'] as const) {
            const before = requests.length;
            publishHomeAccountChange(scope.serverId, ['workflow-run:run-a'], { source: recovery, changeKinds: ['account'] });
            await vi.waitFor(() => expect(requests).toHaveLength(before + 1));
            await flushHookEffects();
        }
        for (const entityIds of [[], ['workflow-run:']] as const) {
            const before = requests.length;
            publishHomeAccountChange(scope.serverId, entityIds, { source, changeKinds: ['account'] });
            await vi.waitFor(() => expect(requests).toHaveLength(before + 1));
            await flushHookEffects();
        }
        requests.length = 0;
        attentionChanged = true;
        publishHomeAccountChange(scope.serverId, ['self'], { source: 'catch-up-pending', changeKinds: ['account'] });
        await vi.waitFor(() => expect(repository.getSnapshot().attention.discussions.map(entry => entry.discussion.id))
            .toEqual(['discussion-a']));
        expect(requests).toEqual(['/v1/discussions/attention']);
        denied = true;
        publishHomeAccountChange(scope.serverId, ['workflow-run:run-a', 'teams'], {
            source: 'catch-up-pending', changeKinds: ['account'],
        });
        await vi.waitFor(() => expect(repository.getSnapshot().attention.errorCode).toBe('discussion_read_denied'));
        expect(repository.getSnapshot().attention.discussions).toEqual([]);
        expect(requests).toEqual(['/v1/discussions/attention', '/v1/discussions/attention']);
    } finally { leave(); repository.clear(); }
});

it('shares snapshot attention with the mounted thread instead of rereading its occurrence', async () => {
    const requests: string[] = [];
    let head = 1;
    const entries = Array.from({ length: 200 }, (_, index) => ({ discussion: storedSummary(index === 0 ? 'discussion-a' : `attention-${index}`),
        occurrences: [{ type: 'update', message: storedMessage(index === 0 ? 'discussion-a' : `attention-${index}`, 1) }] }));
    const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
        requests.push(path);
        const url = new URL(path, 'https://home.invalid');
        if (url.pathname === '/v1/discussions/attention') return response({ discussions: url.searchParams.has('discussionId')
            ? entries.filter(entry => entry.discussion.id === url.searchParams.get('discussionId')) : entries, nextCursor: null, incomplete: false });
        if (url.pathname === '/v1/discussions/discussion-a') return response({ discussion: { ...storedSummary('discussion-a'), messageSeq: head } });
        const after = Number(url.searchParams.get('afterSeq') ?? 0);
        return response({ messages: Array.from({ length: head }, (_, index) => storedMessage('discussion-a', index + 1))
            .filter(row => row.seq > after), hasMoreOlder: false, messageSeq: head });
    }) });
    await repository.refreshDiscussion('discussion-a');
    await repository.refreshAttention();
    expect(repository.getSnapshot().attention.discussions).toHaveLength(200);
    const leaves = [repository.mount({ discussionId: 'discussion-a' }), repository.mount({ attention: true })];
    try {
        requests.length = 0;
        head = 2;
        publishHomeAccountChange(scope.serverId, undefined, { source: 'catch-up-pending' });
        await vi.waitFor(() => expect(repository.getSnapshot().threads['discussion-a']?.messages.map(row => row.seq)).toEqual([1, 2]));
        expect(requests.filter(path => new URL(path, 'https://home.invalid').pathname === '/v1/discussions/attention'))
            .toEqual(['/v1/discussions/attention']);
    } finally { leaves.forEach(leave => leave()); repository.clear(); }
});

it.each([false, true])('revalidates a demanded archived page on snapshot repair while a closed archive stays lazy (loaded=%s)', async loaded => {
    let title = 'Before repair';
    const requests: string[] = [];
    const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
        requests.push(path);
        const url = new URL(path, 'https://home.invalid');
        const archived = url.searchParams.get('state') === 'archived';
        return response({ discussions: archived ? [{ ...storedSummary('archived-a'), archivedAt: 1,
            titleContent: { t: 'plain', v: { v: 1, title } } }] : [], nextCursor: null });
    }) });
    await repository.refreshList('active');
    if (loaded) await repository.refreshList('archived');
    const leave = repository.mount();
    try {
        requests.length = 0;
        title = 'After repair';
        publishHomeAccountChange(scope.serverId, undefined, { source: 'catch-up-pending' });
        await vi.waitFor(() => expect(requests.some(path => new URL(path, 'https://home.invalid').searchParams.get('state') === 'active')).toBe(true));
        await flushHookEffects();
        const archived = repository.getSnapshot().lists.archived;
        if (loaded) {
            expect(archived.items.map(row => row.title)).toEqual(['After repair']);
            expect(requests.filter(path => new URL(path, 'https://home.invalid').searchParams.get('state') === 'archived'))
                .toEqual(['/v1/discussions?state=archived']);
        } else {
            expect(archived).toMatchObject({ status: 'idle', items: [] });
            expect(requests.filter(path => new URL(path, 'https://home.invalid').searchParams.get('state') === 'archived'))
                .toEqual(['/v1/discussions?state=archived&limit=1']);
        }
    } finally { leave(); repository.clear(); }
});

it('receives a new message through HTTP change catch-up and the mounted repository without a forced refresh', async () => {
    let head = 1;
    const requests: string[] = [];
    const request = async (path: string) => {
        requests.push(path);
        const url = new URL(path, 'https://home.invalid');
        if (url.pathname === '/v2/changes') return response({ changes: [{ cursor: 2, kind: 'discussion',
            entityId: 'discussion-a', changedAt: 2,
            hint: { v: 1, discussions: true, changes: { resource: true, readState: true } } }], nextCursor: 2 });
        if (url.pathname === '/v1/discussions/discussion-a') return response({ discussion: {
            ...storedSummary('discussion-a'), messageSeq: head } });
        const after = Number(url.searchParams.get('afterSeq') ?? 0);
        return response({ messages: Array.from({ length: head }, (_, index) => storedMessage('discussion-a', index + 1))
            .filter(row => row.seq > after), hasMoreOlder: false, messageSeq: head });
    };
    const repository = createDiscussionRepository({ scope, address, client: httpClient(request) });
    await repository.refreshDiscussion('discussion-a');
    const seed = repository.getSnapshot().threads['discussion-a']!.messages[0];
    const leave = repository.mount({ discussionId: 'discussion-a' });
    let subscriberReceivedOriginal = false;
    const unsubscribe = repository.subscribe(() => {
        subscriberReceivedOriginal ||= repository.getSnapshot().threads['discussion-a']?.messages.some(row => row.seq === 2) === true;
    });
    try {
        requests.length = 0;
        head = 2;
        const credentials = { token: 'changes-boundary-token' };
        const result = await runSocketReconnectCatchUpViaChanges({ credentials, accountId: scope.accountId,
            afterCursor: '1', changesPageLimit: 200, forceSnapshotRefresh: false,
            fetchChanges: params => fetchChanges({ ...params, request }),
            applyPlanned: planned => applyPlannedChangeActions({ planned, credentials,
                isSessionMessagesLoaded: () => false,
                publishAccountChanges: changes => publishMountedDiscussionChanges({ ...scope, changes }),
                invalidate: {}, invalidateMessagesForSession: async () => {}, invalidateScmStatusForSession: () => {},
                applyTodoSocketUpdates: async () => {}, kvBulkGet: async () => ({ values: [] }) }),
            snapshotRefresh: async () => { throw new Error('Unexpected snapshot repair'); },
        });
        expect(result).toMatchObject({ status: 'ok', nextCursor: '2' });
        await vi.waitFor(() => expect(subscriberReceivedOriginal).toBe(true));
        const thread = repository.getSnapshot().threads['discussion-a']!;
        expect(thread).toMatchObject({ status: 'ready', incomplete: false, hasMoreOlder: false, messageSeq: 2 });
        expect(thread.messages.map(row => row.seq)).toEqual([1, 2]);
        expect(thread.messages[0]).toBe(seed);
        expect(requests).toEqual(['/v2/changes?after=1&limit=200', '/v1/discussions/discussion-a',
            '/v1/discussions/discussion-a/messages?afterSeq=1', '/v1/discussions/discussion-a']);
    } finally { unsubscribe(); leave(); repository.clear(); }
});

it('retains newly received history when an older summary read fails and then recovers', async () => {
    const pendingSummary = createDeferred<Response>();
    const summaryStarted = createDeferred<void>();
    const requests: string[] = [];
    let delaySummary = false;
    let head = 1;
    const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
        requests.push(path);
        const url = new URL(path, 'https://home.invalid');
        if (!url.pathname.endsWith('/messages')) {
            if (delaySummary) {
                delaySummary = false;
                summaryStarted.resolve();
                return pendingSummary.promise;
            }
            return response({ discussion: { ...storedSummary('discussion-a'), messageSeq: head } });
        }
        const after = Number(url.searchParams.get('afterSeq') ?? 0);
        return response({ messages: Array.from({ length: head }, (_, index) => storedMessage('discussion-a', index + 1))
            .filter(row => row.seq > after), hasMoreOlder: false, messageSeq: head });
    }) });
    try {
        await repository.refreshDiscussion('discussion-a');
        const seed = repository.getSnapshot().threads['discussion-a']!.messages[0];
        delaySummary = true;
        const staleSummary = repository.refreshSummary('discussion-a');
        await summaryStarted.promise;
        head = 2;
        await repository.refreshMessages('discussion-a');
        const received = repository.getSnapshot().threads['discussion-a']!.messages;
        expect(received.map(row => row.seq)).toEqual([1, 2]);
        pendingSummary.resolve(response({ error: 'discussions_unavailable' }, 409));
        await staleSummary;
        await repository.refreshSummary('discussion-a');
        const recovered = repository.getSnapshot().threads['discussion-a']!;
        expect(recovered).toMatchObject({ status: 'ready', incomplete: false, hasMoreOlder: false, messageSeq: 2 });
        expect(recovered.messages).toBe(received);
        expect(recovered.messages[0]).toBe(seed);
        expect(requests.filter(path => path.includes('/messages'))).toEqual([
            '/v1/discussions/discussion-a/messages', '/v1/discussions/discussion-a/messages?afterSeq=1',
        ]);
    } finally { repository.clear(); }
});

it('shares summary failure and recovery across observers without retrying at idle', async () => {
    let unavailable = true;
    let title = 'Initial';
    const requests: string[] = [];
    const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
        requests.push(path);
        return unavailable ? response({ error: 'discussions_unavailable' }, 409)
            : response({ discussion: { ...storedSummary('discussion-a'), titleContent: { t: 'plain', v: { v: 1, title } } } });
    }) });
    const leave = repository.mount({ discussionId: 'discussion-a', projection: 'summary' });
    try {
        const refused = await Promise.all(Array.from({ length: 3 }, () => repository.readSummaryObservation('discussion-a')));
        expect(refused).toEqual(Array(3).fill({ kind: 'failed', errorCode: 'discussions_unavailable' }));
        await flushHookEffects();
        expect(requests).toEqual(['/v1/discussions/discussion-a']);
        unavailable = false;
        const recovered = await Promise.all(Array.from({ length: 3 }, () => repository.readSummaryObservation('discussion-a')));
        expect(recovered).toEqual(Array(3).fill({ kind: 'succeeded', value: { discussionId: 'discussion-a', revision: 0 } }));
        expect(requests).toEqual(Array(2).fill('/v1/discussions/discussion-a'));
        leave();
        title = 'Changed while unobserved';
        await repository.readSummaryObservation('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']?.summary?.title).toBe(title);
        expect(requests).toEqual(Array(3).fill('/v1/discussions/discussion-a'));
    } finally { leave(); repository.clear(); }
});

it('refreshes retained addressed delivery projections by exact id without replaying ordinary history', async () => {
    const requests: string[] = [];
    let delivery: DiscussionOpenedMessageV1['participantDeliveryV1'] = [
        { participantSessionId: 'agent-a', disposition: 'held', code: 'session_input_target_unavailable' },
    ];
    const rows = Array.from({ length: 300 }, (_, index) => storedMessage('discussion-a', index + 1));
    const question = () => ({ ...rows[1]!, addressingV1: { throughSeq: 2, participantSessionIds: ['agent-a'] }, participantDeliveryV1: delivery });
    const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
        requests.push(path);
        const url = new URL(path, 'https://home.invalid');
        if (!url.pathname.endsWith('/messages')) return response({ discussion: { ...storedSummary('discussion-a'), messageSeq: 300 } });
        const messages = url.searchParams.has('messageId') ? [question()]
            : url.searchParams.has('afterSeq') ? [] : rows.map(row => row.seq === 2 ? question() : row);
        return response({ messages, hasMoreOlder: false, messageSeq: 300 });
    }) });
    await repository.refreshDiscussion('discussion-a');
    expect(repository.getSnapshot().threads['discussion-a']?.messages[1]?.participantDeliveryV1).toEqual(delivery);
    const ordinary = repository.getSnapshot().threads['discussion-a']!.messages[0];
    const leave = repository.mount({ discussionId: 'discussion-a' });
    try {
        const deliveries: NonNullable<DiscussionOpenedMessageV1['participantDeliveryV1']>[] = [
            [{ participantSessionId: 'agent-a', disposition: 'failed', failure: { code: 'action_disabled', phase: 'action_admission', retryable: false } }],
            [],
        ];
        for (const [index, next] of deliveries.entries()) {
            delivery = next;
            requests.length = 0;
            publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: index + 1, kind: 'discussion', entityId: 'discussion-a', changedAt: index + 1 }] });
            await vi.waitFor(() => expect(repository.getSnapshot().threads['discussion-a']?.messages[1]?.participantDeliveryV1).toEqual(delivery));
            expect(requests.filter(path => path.includes('/messages')).sort()).toEqual([
                '/v1/discussions/discussion-a/messages?afterSeq=300',
                '/v1/discussions/discussion-a/messages?messageId=message-2',
            ]);
            expect(repository.getSnapshot().threads['discussion-a']!.messages[0]).toBe(ordinary);
        }
    } finally { leave(); repository.clear(); }
});

it('refreshes only matching mounted Doc queries on Artifact changes and withdraws revoked roots', async () => {
    const requests: string[] = [];
    let refused = false;
    const row = (artifactId: string, index: number) => ({ ...storedSummary(`${artifactId}-${index}`),
        anchor: { kind: 'doc' as const, doc: { ref: { kind: 'doc' as const, serverId: scope.serverId, artifactId },
            revision: { headerVersion: 1, bodyVersion: 1 } } }, firstMessage: storedMessage(`${artifactId}-${index}`, 1) });
    const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
        requests.push(path);
        const url = new URL(path, 'https://home.invalid');
        if (url.pathname === '/v1/discussions') {
            const artifactId = url.searchParams.get('anchorDocArtifactId')!;
            const offset = Number(url.searchParams.get('cursor') ?? 0);
            return response({ discussions: url.searchParams.get('state') === 'archived' || refused && artifactId === 'doc-a'
                ? [] : Array.from({ length: 100 }, (_, index) => row(artifactId, offset + index)),
            nextCursor: url.searchParams.get('state') === 'archived' || refused && artifactId === 'doc-a' || offset === 200 ? null : String(offset + 100) });
        }
        return response({ error: 'discussion_content_unavailable' }, 409);
    }) });
    const releases: (() => void)[] = [];
    try {
        for (const artifactId of ['doc-a', 'doc-b']) {
            await repository.refreshDocList(artifactId);
            releases.push(repository.mount({ anchorDocArtifactId: artifactId }));
        }
        expect(repository.getDocListSnapshot('doc-a').items).toHaveLength(300);
        requests.length = 0;
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'artifact', entityId: 'unrelated-approval', changedAt: 1 }] });
        await flushHookEffects();
        expect(requests).toEqual([]);
        refused = true;
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 2, kind: 'artifact', entityId: 'doc-a', changedAt: 2 }] });
        await vi.waitFor(() => expect(repository.getDocListSnapshot('doc-a').items).toEqual([]));
        expect(repository.getSnapshot().threads['doc-a-0']).toMatchObject({ summary: null, messages: [], status: 'locked' });
        expect(repository.getDocListSnapshot('doc-b').items).toHaveLength(300);
        expect(requests.filter(path => new URL(path, 'https://home.invalid').pathname === '/v1/discussions')
            .every(path => new URL(path, 'https://home.invalid').searchParams.get('anchorDocArtifactId') === 'doc-a')).toBe(true);
    } finally { releases.forEach(release => release()); repository.clear(); }
});

it('preserves non-content round and comment summaries from the list transport without detail reads', async () => {
    const requests: string[] = [];
    const row = { ...storedSummary('discussion-summary'), openCommentCount: 3,
        roundOutcomeV1: { runId: 'run', pattern: 'fresh_opinions', answerCount: 3, synthesized: true, settled: true } };
    const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
        requests.push(path);
        return response({ discussions: [row], nextCursor: null });
    }) });
    try {
        await repository.refreshList('active');
        expect(repository.getSnapshot().lists.active.status).toBe('ready');
        expect(repository.getSnapshot().lists.active.items[0]).toMatchObject({ openCommentCount: 3,
            roundOutcomeV1: row.roundOutcomeV1 });
        const urls = requests.map(path => new URL(path, 'https://home.invalid'));
        expect(urls.map(url => url.pathname)).toEqual(['/v1/discussions', '/v1/discussions']);
        expect(urls.map(url => url.searchParams.get('state'))).toEqual(['active', 'archived']);
    } finally { repository.clear(); }
});

it('patches only the changed list row across 300 Discussions and three loaded pages per mounted list', async () => {
    const requests: string[] = [];
    const rows = Array.from({ length: 300 }, (_, index) => {
        const row = storedSummary(`discussion-${index}`);
        return { ...row, anchor: { kind: 'session' as const, sessionId: 'source' },
            latestMessage: { ...row.latestMessage, createdAt: 1000 - index } };
    });
    const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
        requests.push(path);
        const url = new URL(path, 'https://home.invalid');
        if (url.pathname === '/v1/discussions') {
            const offset = Number(url.searchParams.get('cursor') ?? 0);
            return response({ discussions: url.searchParams.get('state') === 'archived' ? [] : rows.slice(offset, offset + 100),
                nextCursor: url.searchParams.get('state') === 'archived' || offset === 200 ? null : String(offset + 100) });
        }
        const row = rows.find(row => url.pathname === `/v1/discussions/${row.id}`);
        return row ? response({ discussion: row }) : response({ error: 'not_found' }, 404);
    }) });
    for (const anchor of [undefined, 'source']) {
        await repository.refreshList('active', undefined, anchor);
        await repository.loadMoreList('active', undefined, anchor);
        await repository.loadMoreList('active', undefined, anchor);
    }
    const leaveHome = repository.mount();
    const leaveAnchor = repository.mount({ anchorSessionId: 'source' });
    const unchangedCounter = createRenderCommitCounter();
    const changedCounter = createRenderCommitCounter();
    const unchanged = await renderHook(() => {
        const row = useSyncExternalStore(repository.subscribe, () => repository.getSnapshot().lists.active.items[150]);
        useRenderCommitCounter(unchangedCounter);
        return row;
    });
    const changed = await renderHook(() => {
        const row = useSyncExternalStore(repository.subscribe, () => repository.getSnapshot().lists.active.items[0]);
        useRenderCommitCounter(changedCounter);
        return row;
    });
    const states: string[] = [];
    const unsubscribe = repository.subscribe(() => states.push(repository.getSnapshot().lists.active.status));
    try {
        requests.length = 0;
        unchangedCounter.reset(); changedCounter.reset();
        for (let arrival = 1; arrival <= 5; arrival++) {
            const row = rows[0]!;
            rows[0] = { ...row, messageSeq: row.messageSeq + 1, unreadCount: row.unreadCount + 1,
                latestMessage: { ...row.latestMessage, seq: row.messageSeq + 1, createdAt: 1000 + arrival } };
            await act(async () => {
                publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: arrival, kind: 'discussion', entityId: row.id, changedAt: arrival }] });
                await flushHookEffects();
                await vi.waitFor(() => expect(repository.getSnapshot().lists.active.items[0]?.messageSeq).toBe(arrival + 1));
            });
            const listReads = requests.filter(path => new URL(path, 'https://home.invalid').pathname === '/v1/discussions');
            if (listReads.length) console.info('Discussion list arrival budget violation', { arrivals: arrival, listReads: listReads.length });
            expect(listReads).toEqual([]);
        }
        const listReads = requests.filter(path => new URL(path, 'https://home.invalid').pathname === '/v1/discussions');
        console.info('Discussion list arrival cost', { arrivals: 5, loadedDiscussions: 300, loadedPagesPerList: 3,
            listReads: listReads.length, summaryReads: requests.length - listReads.length,
            unchanged: unchangedCounter.read(), changed: changedCounter.read() });
        expect(listReads).toEqual([]);
        expect(requests).toEqual(Array(5).fill('/v1/discussions/discussion-0'));
        expect(unchangedCounter.read()).toEqual({ renders: 0, commits: 0 });
        expect(changedCounter.read()).toEqual({ renders: 5, commits: 5 });
        expect(states).not.toContain('loading');
        expect(repository.getListSnapshot('source').lists.active.items[0]?.messageSeq).toBe(6);
    } finally { unsubscribe(); leaveHome(); leaveAnchor(); await unchanged.unmount(); await changed.unmount(); repository.clear(); }
});

it('keeps the newer summary when consecutive invalidations overlap an older exact read', async () => {
    const older = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['get']>>>();
    const newer = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['get']>>>();
    const get = vi.fn<DiscussionRepositoryClient['get']>().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const list = vi.fn<DiscussionRepositoryClient['list']>(async input => ({ kind: 'succeeded', value:
        listResult(input?.state === 'archived' ? [] : [summary('discussion-a', null, 1)], null) }));
    const repository = createDiscussionRepository({ scope, address, client: client({ list, get }) });
    await repository.refreshList('active');
    const leave = repository.mount();
    try {
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: 'discussion-a', changedAt: 1 }] });
        await flushHookEffects();
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 2, kind: 'discussion', entityId: 'discussion-a', changedAt: 2 }] });
        await flushHookEffects();
        newer.resolve({ kind: 'succeeded', value: { v: 1, serverId: scope.serverId, discussion: summary('discussion-a', null, 3) } });
        await flushHookEffects();
        older.resolve({ kind: 'succeeded', value: { v: 1, serverId: scope.serverId, discussion: summary('discussion-a', null, 2) } });
        await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
        await flushHookEffects();
        expect(repository.getSnapshot().lists.active.items[0]?.messageSeq).toBe(3);
    } finally { leave(); repository.clear(); }
});

it.each([false, true])('keeps archived placement within its loaded frontier without querying a closed inventory (loaded=%s)', async loaded => {
    const requests: string[] = [];
    let archived = false;
    const target = { ...storedSummary('archived-target'), latestMessage: { ...storedSummary('archived-target').latestMessage, createdAt: 50 } };
    const olderState = Array.from({ length: 100 }, (_, index) => ({ ...storedSummary(`archived-${index}`), archivedAt: 1,
        latestMessage: { ...storedSummary(`archived-${index}`).latestMessage, createdAt: 1000 - index } }));
    const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
        requests.push(path);
        const url = new URL(path, 'https://home.invalid');
        if (url.pathname === '/v1/discussions') return response({ discussions: url.searchParams.get('state') === 'archived'
            ? loaded ? olderState : archived ? [{ ...target, archivedAt: 1 }] : []
            : loaded && !archived ? [target] : [], nextCursor: url.searchParams.get('state') === 'archived' && loaded ? 'older' : null });
        return response({ discussion: { ...target, archivedAt: 1 } });
    }) });
    await repository.refreshList('active');
    if (loaded) await repository.refreshList('archived');
    const leave = repository.mount();
    try {
        requests.length = 0;
        archived = true;
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: target.id, changedAt: 1 }] });
        await flushHookEffects();
        await vi.waitFor(() => expect(repository.getSnapshot().threads[target.id]?.summary?.archivedAt).toBe(1));
        await flushHookEffects();
        expect(requests).toEqual([`/v1/discussions/${target.id}`]);
        if (loaded) {
            expect(repository.getSnapshot().lists.archived.items).toHaveLength(100);
            expect(repository.getSnapshot().lists.archived.items.some(row => row.id === target.id)).toBe(false);
            expect(repository.getSnapshot().lists.archived.nextCursor).toBe('older');
        } else expect(repository.getSnapshot().lists.archived.status).toBe('idle');
        expect(repository.getSnapshot().archivedExistence).toBe('present');
    } finally { leave(); repository.clear(); }
});



it('places a known reorder from its summary, rechecks unknown membership and leaves unrelated anchors alone', async () => {
    const requests: string[] = [];
    let rows = [storedSummary('first'), storedSummary('second')].map((row, index) => ({ ...row,
        anchor: { kind: 'session' as const, sessionId: 'source' }, latestMessage: { ...row.latestMessage, createdAt: 100 - index } }));
    const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
        requests.push(path);
        const url = new URL(path, 'https://home.invalid');
        if (url.pathname === '/v1/discussions') return response({ discussions: url.searchParams.get('state') === 'archived'
            || url.searchParams.get('anchorSessionId') === 'unrelated' ? [] : rows, nextCursor: null });
        return response({ discussion: rows.find(row => url.pathname.endsWith(`/${row.id}`)) });
    }) });
    await repository.refreshList('active');
    await repository.refreshAnchoredList('unrelated', 'active');
    const leave = repository.mount();
    const leaveAnchor = repository.mount({ anchorSessionId: 'unrelated' });
    try {
        const row = rows[1]!;
        rows = [{ ...row, latestMessage: { ...row.latestMessage, createdAt: 200 } }, rows[0]!];
        requests.length = 0;
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: row.id, changedAt: 1 }] });
        await flushHookEffects();
        expect(repository.getSnapshot().lists.active.items.map(row => row.id)).toEqual(['second', 'first']);
        expect(requests.some(path => { const url = new URL(path, 'https://home.invalid');
            return url.pathname === '/v1/discussions' && url.searchParams.get('state') === 'active'; })).toBe(false);
        expect(requests.some(path => path.includes('anchorSessionId=unrelated'))).toBe(false);
        const unknown = { ...storedSummary('new'), anchor: { kind: 'session' as const, sessionId: 'source' },
            latestMessage: { ...storedSummary('new').latestMessage, createdAt: 300 } };
        rows = [unknown, ...rows];
        requests.length = 0;
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 2, kind: 'discussion', entityId: unknown.id, changedAt: 2 }] });
        await flushHookEffects();
        expect(repository.getSnapshot().lists.active.items.map(row => row.id)).toEqual(['new', 'second', 'first']);
        expect(requests.some(path => { const url = new URL(path, 'https://home.invalid');
            return url.pathname === '/v1/discussions' && url.searchParams.get('state') === 'active'; })).toBe(true);
        expect(requests.some(path => path.includes('anchorSessionId=unrelated'))).toBe(false);
    } finally { leaveAnchor(); leave(); repository.clear(); }
});

it('rechecks only a changed Doc root and withdraws its source-refused content without rereading sibling roots', async () => {
    const requests: string[] = [];
    let refused = false;
    const rows = ['doc-thread-a', 'doc-thread-b'].map(id => ({ ...storedSummary(id),
        anchor: { kind: 'doc' as const, doc: { ref: { kind: 'doc' as const, serverId: scope.serverId, artifactId: 'source-doc' },
            revision: { headerVersion: 1, bodyVersion: 1 } } }, firstMessage: storedMessage(id, 1) }));
    const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
        requests.push(path);
        const url = new URL(path, 'https://home.invalid');
        if (url.pathname === '/v1/discussions') return response({ discussions: refused ? [rows[1]] : rows, nextCursor: null });
        const row = rows.find(row => url.pathname.startsWith(`/v1/discussions/${row.id}`))!;
        if (url.pathname.endsWith('/messages')) return refused && row.id === rows[0]!.id
            ? response({ error: 'discussion_content_unavailable' }, 409)
            : response({ messages: [row.firstMessage], hasMoreOlder: false, messageSeq: 1 });
        const { firstMessage: _root, ...discussion } = row;
        return response({ discussion });
    }) });
    await repository.refreshDocList('source-doc');
    const sibling = repository.getDocListSnapshot('source-doc').items[1];
    const leave = repository.mount({ anchorDocArtifactId: 'source-doc' });
    try {
        requests.length = 0;
        refused = true;
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: rows[0]!.id, changedAt: 1 }] });
        await flushHookEffects();
        expect(repository.getDocListSnapshot('source-doc').items).toEqual([sibling]);
        expect(repository.getSnapshot().threads[rows[0]!.id]).toMatchObject({ summary: null, messages: [], status: 'locked' });
        expect(requests).toEqual([`/v1/discussions/${rows[0]!.id}`, `/v1/discussions/${rows[0]!.id}/messages?messageId=message-1`]);
    } finally { leave(); repository.clear(); }
});

it('refreshes a changed closed Discussion without hydrating retained histories from the open rail', async () => {
    const requests: string[] = [];
    const ids = ['discussion-a', 'discussion-b', 'discussion-c'];
    let revoked = false;
    const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
        const url = new URL(path, 'https://home.invalid');
        requests.push(url.pathname);
        const id = url.pathname.split('/')[3] ?? ids[0]!;
        if (url.pathname === '/v1/discussions') return response({ discussions: url.searchParams.get('state') === 'archived'
            ? [] : ids.filter(id => !revoked || id !== ids[0]).map(id => ({ ...storedSummary(id), messageSeq: 300 })), nextCursor: null });
        if (revoked && id === ids[0]) return response({ error: 'discussion_read_denied' }, 403);
        if (!url.pathname.endsWith('/messages')) return response({ discussion: { ...storedSummary(id), messageSeq: 300 } });
        const after = Number(url.searchParams.get('afterSeq') ?? 0);
        return response({ messages: Array.from({ length: 300 }, (_, index) => storedMessage(id, index + 1))
            .filter(row => row.seq > after), hasMoreOlder: false, messageSeq: 300 });
    }) });
    for (const id of ids) await repository.refreshDiscussion(id);
    await repository.refreshList('active');
    requests.length = 0;
    const unmount = repository.mount();
    try {
        publishMountedDiscussionChanges({ serverId: scope.serverId, accountId: scope.accountId,
            changes: [{ cursor: 1, kind: 'discussion', entityId: ids[0]!, changedAt: 1 }] });
        await flushHookEffects();
        console.info('Discussion rail invalidation reads', requests);
        expect(requests.filter(path => path.endsWith('/messages'))).toEqual([]);
        expect(requests.filter(path => ids.slice(1).some(id => path === `/v1/discussions/${id}`))).toEqual([]);
        expect(repository.getSnapshot().threads[ids[0]!]!.messages).toHaveLength(300);
        requests.length = 0;
        revoked = true;
        publishMountedDiscussionChanges({ serverId: scope.serverId, accountId: scope.accountId,
            changes: [{ cursor: 2, kind: 'discussion', entityId: ids[0]!, changedAt: 2 }] });
        await flushHookEffects();
        expect(repository.getSnapshot().threads[ids[0]!]).toMatchObject({ status: 'revoked', summary: null, messages: [] });
        expect(repository.getSnapshot().threads[ids[1]!]!.messages).toHaveLength(300);
        expect(requests.filter(path => path.endsWith('/messages'))).toEqual([]);
        revoked = false;
        publishMountedDiscussionChanges({ serverId: scope.serverId, accountId: scope.accountId,
            changes: [{ cursor: 3, kind: 'discussion', entityId: ids[0]!, changedAt: 3 }] });
        await flushHookEffects();
        expect(repository.getSnapshot().threads[ids[0]!]!.summary?.id).toBe(ids[0]);
        expect(repository.getSnapshot().threads[ids[0]!]!.messages).toHaveLength(0);
    } finally { unmount(); repository.clear(); }
});

it('reconciles a relationship-only latest-message actor update from the list into an already opened thread', async () => {
    const profile = { name: 'QA N3 Bob', firstName: null, lastName: null, username: 'qa-n3b', avatarUrl: null };
    const root = message(1);
    const currentMessage = {
        ...message(2),
        authorAccountId: 'bob',
        accountActor: { v: 1 as const, accountId: 'bob', accessibility: 'current' as const, profile },
    };
    const latestMessage = (row: DiscussionOpenedMessageV1): DiscussionOpenedSummaryV1['latestMessage'] => ({
        id: row.id,
        localId: row.localId,
        seq: row.seq,
        authorAccountId: row.authorAccountId,
        accountActor: row.accountActor,
        producerV1: row.producerV1,
        createdAt: row.createdAt,
    });
    const openedSummary = { ...summary('discussion-a', null, 2), firstMessage: root, latestMessage: latestMessage(currentMessage) };
    let listedSummary = openedSummary;
    const read = vi.fn<DiscussionRepositoryClient['read']>().mockResolvedValue({
        kind: 'succeeded', value: readResult([root, currentMessage], false, 2),
    });
    const repository = createDiscussionRepository({ scope, address, client: client({
        get: async () => ({ kind: 'succeeded', value: { v: 1, serverId: scope.serverId, discussion: openedSummary } }),
        read,
        list: async input => ({ kind: 'succeeded', value: listResult(input?.state === 'archived' ? [] : [listedSummary], null) }),
    }) });
    try {
        await repository.refreshDiscussion('discussion-a');
        const before = repository.getSnapshot().threads['discussion-a']!;
        const unchangedRoot = before.messages[0];
        expect(before.messages[1]?.accountActor?.accessibility).toBe('current');
        read.mockClear();

        listedSummary = {
            ...openedSummary,
            latestMessage: {
                ...openedSummary.latestMessage,
                accountActor: { ...openedSummary.latestMessage.accountActor!, accessibility: 'former' },
            },
        };
        await repository.refreshList('active');

        const after = repository.getSnapshot();
        expect(after.lists.active.items[0]?.latestMessage.accountActor?.accessibility).toBe('former');
        expect(after.threads['discussion-a']?.messages[1]?.accountActor?.accessibility).toBe('former');
        expect(after.threads['discussion-a']?.messages[0]).toBe(unchangedRoot);
        expect(read).not.toHaveBeenCalled();
    } finally { repository.clear(); }
});

it('publishes only a changed thread when repeated summary refreshes return equal facts', async () => {
    const profile = { name: 'QA N3 Bob', firstName: null, lastName: null, username: 'qa-n3b', avatarUrl: null };
    const root = message(1);
    let openedSummary: DiscussionOpenedSummaryV1 = {
        ...summary('discussion-a', null, 1),
        firstMessage: root,
        participantAccounts: [{
            v: 1,
            accountId: 'bob',
            accessibility: 'current',
            profile,
        }],
    };
    const repository = createDiscussionRepository({ scope, address, client: client({
        get: async () => ({ kind: 'succeeded', value: { v: 1, serverId: scope.serverId, discussion: openedSummary } }),
        read: async () => ({ kind: 'succeeded', value: readResult([root], false, 1) }),
    }) });
    await repository.refreshDiscussion(openedSummary.id);
    const initialThread = repository.getSnapshot().threads[openedSummary.id]!;
    const wholeSnapshotCounter = createRenderCommitCounter();
    const unaffectedCounter = createRenderCommitCounter();
    const wholeSnapshot = await renderHook(() => {
        const snapshot = useDiscussionRepositorySnapshot(repository);
        useRenderCommitCounter(wholeSnapshotCounter);
        return snapshot.threads[openedSummary.id];
    });
    const unaffected = await renderHook(() => {
        const thread = useSyncExternalStore(repository.subscribe, () => repository.getSnapshot().threads['discussion-b']);
        useRenderCommitCounter(unaffectedCounter);
        return thread;
    });
    let publications = 0;
    const unsubscribe = repository.subscribe(() => { publications += 1; });
    try {
        wholeSnapshotCounter.reset();
        unaffectedCounter.reset();
        for (let refresh = 0; refresh < 5; refresh++) {
            await act(async () => { await repository.refreshSummary(openedSummary.id); });
        }
        console.info('Discussion equal-summary refresh cost', {
            refreshes: 5,
            publications,
            wholeSnapshot: wholeSnapshotCounter.read(),
            unaffected: unaffectedCounter.read(),
        });
        expect(publications).toBe(0);
        expect(wholeSnapshotCounter.read()).toEqual({ renders: 0, commits: 0 });
        expect(unaffectedCounter.read()).toEqual({ renders: 0, commits: 0 });
        expect(repository.getSnapshot().threads[openedSummary.id]).toBe(initialThread);

        openedSummary = {
            ...openedSummary,
            participantAccounts: openedSummary.participantAccounts?.map(actor => actor.accountId === 'bob'
                ? { ...actor, accessibility: 'former' as const }
                : actor),
        };
        await act(async () => { await repository.refreshSummary(openedSummary.id); });
        console.info('Discussion changed-summary refresh cost', {
            publications,
            wholeSnapshot: wholeSnapshotCounter.read(),
            unaffected: unaffectedCounter.read(),
        });
        const changedThread = repository.getSnapshot().threads[openedSummary.id]!;
        expect(publications).toBe(1);
        expect(wholeSnapshotCounter.read()).toEqual({ renders: 1, commits: 1 });
        expect(unaffectedCounter.read()).toEqual({ renders: 0, commits: 0 });
        expect(changedThread).not.toBe(initialThread);
        expect(changedThread.messages).toBe(initialThread.messages);
        expect(changedThread.summary?.firstMessage).toBe(initialThread.summary?.firstMessage);
        expect(changedThread.summary?.latestMessage).toBe(initialThread.summary?.latestMessage);
        expect(changedThread.summary?.participantAccounts?.[0]?.accessibility).toBe('former');
    } finally {
        unsubscribe();
        await wholeSnapshot.unmount();
        await unaffected.unmount();
        repository.clear();
    }
});

it('publishes no unchanged history or list rows on a warm 300-message refresh and does no settled idle reads', async () => {
    const requests: string[] = [];
    const rows = Array.from({ length: 300 }, (_, index) => storedMessage('discussion-a', index + 1));
    const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
        const url = new URL(path, 'https://home.invalid');
        requests.push(url.pathname);
        if (url.pathname === '/v1/discussions') return response({ discussions: [{ ...storedSummary('discussion-a'), messageSeq: rows.length }], nextCursor: null });
        if (!url.pathname.endsWith('/messages')) return response({ discussion: { ...storedSummary('discussion-a'), messageSeq: rows.length } });
        const after = Number(url.searchParams.get('afterSeq') ?? 0);
        return response({ messages: rows.filter(row => row.seq > after), hasMoreOlder: false, messageSeq: rows.length });
    }) });
    await repository.refreshDiscussion('discussion-a');
    await repository.refreshList('active');
    const cold = [...requests];
    requests.length = 0;
    const historyCounter = createRenderCommitCounter();
    const listCounter = createRenderCommitCounter();
    const wholeSnapshotCounter = createRenderCommitCounter();
    const history = await renderHook(() => {
        const messages = useSyncExternalStore(repository.subscribe, () => repository.getSnapshot().threads['discussion-a']!.messages);
        useRenderCommitCounter(historyCounter);
        return messages;
    });
    const list = await renderHook(() => {
        const items = useSyncExternalStore(repository.subscribe, () => repository.getSnapshot().lists.active.items);
        useRenderCommitCounter(listCounter);
        return items;
    });
    const wholeSnapshot = await renderHook(() => {
        const snapshot = useDiscussionRepositorySnapshot(repository);
        useRenderCommitCounter(wholeSnapshotCounter);
        return snapshot;
    });
    let publications = 0;
    const unsubscribe = repository.subscribe(() => { publications += 1; });
    vi.useFakeTimers();
    const timeoutInstalls = vi.spyOn(globalThis, 'setTimeout');
    const intervalInstalls = vi.spyOn(globalThis, 'setInterval');
    const unmount = repository.mount({ discussionId: 'discussion-a' });
    let unmountRail: (() => void) | undefined;
    try {
        historyCounter.reset(); listCounter.reset(); wholeSnapshotCounter.reset();
        await act(async () => { await repository.refreshDiscussion('discussion-a'); await repository.refreshList('active'); });
        const warm = [...requests];
        console.info('Discussion warm refresh cost', { cold, warm, publications,
            wholeSnapshot: wholeSnapshotCounter.read(), history: historyCounter.read(), list: listCounter.read() });
        expect(publications).toBe(0);
        expect(wholeSnapshotCounter.read()).toEqual({ renders: 0, commits: 0 });
        expect(historyCounter.read()).toEqual({ renders: 0, commits: 0 });
        expect(listCounter.read()).toEqual({ renders: 0, commits: 0 });
        requests.length = 0;
        timeoutInstalls.mockClear(); intervalInstalls.mockClear();
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        const discussionIdleRequests = requests.length;
        const discussionTimerInstalls = timeoutInstalls.mock.calls.length + intervalInstalls.mock.calls.length;
        expect(requests).toEqual([]);
        expect(discussionTimerInstalls).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        unmount();
        requests.length = 0;
        timeoutInstalls.mockClear(); intervalInstalls.mockClear();
        unmountRail = repository.mount();
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        const railTimerInstalls = timeoutInstalls.mock.calls.length + intervalInstalls.mock.calls.length;
        console.info('Discussion owner idle cost', { discussionRequestsPerMinute: discussionIdleRequests, railRequestsPerMinute: requests.length,
            discussionTimerInstalls, railTimerInstalls, pendingTimers: vi.getTimerCount() });
        expect(requests).toEqual([]);
        expect(railTimerInstalls).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        unsubscribe(); unmountRail?.(); unmount(); timeoutInstalls.mockRestore(); intervalInstalls.mockRestore();
        vi.useRealTimers(); await history.unmount(); await list.unmount(); await wholeSnapshot.unmount(); repository.clear();
    }
});

function draftSubmission(kind: 'newDiscussion' | 'discussion' = 'newDiscussion'): DiscussionDraftSubmission {
    return {
        scope: { serverId: address.serverId, accountId: 'account-a' },
        address: kind === 'newDiscussion'
            ? { kind }
            : { kind, discussionId: 'discussion-a' },
        currentness: {
            address: kind === 'newDiscussion'
                ? { kind }
                : { kind, discussionId: 'discussion-a' },
            mutationIds: { 'composer.text': 'text-mutation', 'composer.mentions': 'mentions-mutation' },
        },
    };
}



/** Compose the real resource HTTP/crypto adapter; only its request leaves this process. */
function httpClient(request: (path: string, init?: RequestInit) => Promise<Response>,
    crypto: Partial<Pick<Parameters<typeof createDiscussionActionAdapter>[0], 'accountMode' | 'encryption' | 'ownerContentPublicKeyFingerprint'>> = {}): DiscussionRepositoryClient {
    const execute = createDiscussionActionAdapter({ scope, availability: 'available', accountMode: 'plain', encryption: null, request, ...crypto });
    function opened<T>(schema: { parse(value: unknown): T }, value: unknown): DiscussionClientOutcome<T> {
        if (value && typeof value === 'object' && 'errorCode' in value && typeof value.errorCode === 'string') {
            return { kind: 'failed', errorCode: value.errorCode };
        }
        return { kind: 'succeeded', value: schema.parse(value) };
    }
    const context = { surface: 'ui' as const, serverId: scope.serverId };
    const mutation = async (actionId: 'discussion.invite' | 'discussion.participant.remove' | 'discussion.participant.policy.set' | 'discussion.owner.transfer'
        | 'discussion.access.grants.set' | 'discussion.access.grants.remove', input: unknown, signal?: AbortSignal) =>
        opened(DiscussionAccessGrantMutationResponseV1Schema, await execute({ actionId, input, context, signal }));
    return client({
        attention: (input, signal) => readDiscussionAttentionPage({ scope, availability: 'available', accountMode: 'plain', encryption: null, request, ...crypto }, input, signal),
        list: async (input = {}, signal) => opened(DiscussionListResultV1Schema, await execute({ actionId: 'discussion.list', input, context, signal })),
        get: async (discussionId, signal) => opened(DiscussionDetailsResultV1Schema, await execute({ actionId: 'discussion.get', input: { discussionId }, context, signal })),
        read: async (discussionId, input = {}, signal) => opened(DiscussionReadResultV1Schema, await execute({ actionId: 'discussion.read', input: { discussionId, ...input }, context, signal })),
        create: async (input, signal) => opened(DiscussionCreateResultV1Schema, await execute({ actionId: 'discussion.create', input: {
            creationLocalId: input.creationLocalId, title: input.title, anchor: input.anchor, participants: input.participants ? [...input.participants] : undefined,
            firstMessage: { localId: input.messageLocalId, content: input.content,
                mentionedAccountIds: input.mentionedAccountIds === undefined ? undefined : [...input.mentionedAccountIds],
                mentionedSessionIds: input.mentionedSessionIds === undefined ? undefined : [...input.mentionedSessionIds], replyTarget: input.replyTarget },
        }, context, signal })),
        participants: async (discussionId, signal) => opened(DiscussionParticipantsListResponseV1Schema, await execute({ actionId: 'discussion.participants.list', input: { discussionId }, context, signal })),
        listGrants: async (discussionId, signal) => opened(DiscussionAccessGrantsListResponseV1Schema, await execute({ actionId: 'discussion.access.grants.list', input: { discussionId }, context, signal })),
        invite: (input, signal) => mutation('discussion.invite', input, signal),
        removeParticipant: (input, signal) => mutation('discussion.participant.remove', input, signal),
        setParticipantPolicy: (input, signal) => mutation('discussion.participant.policy.set', input, signal),
        transferOwner: (input, signal) => mutation('discussion.owner.transfer', input, signal),
        setGrant: (input, signal) => mutation('discussion.access.grants.set', input, signal),
        removeGrant: (input, signal) => mutation('discussion.access.grants.remove', input, signal),
        leave: async (discussionId, signal) => opened(DiscussionLeaveResponseV1Schema, await execute({ actionId: 'discussion.leave', input: { discussionId }, context, signal })),
    });
}

function storedSummary(id: string) {
    const { title, ...row } = summary(id, null, 1);
    return DiscussionSummaryV1Schema.parse({ ...row, titleContent: { t: 'plain', v: { v: 1, title } } });
}

function storedMessage(discussionId: string, seq: number) {
    const { messageRef: _messageRef, content, ...row } = message(seq, null, discussionId);
    return { ...row, content: { t: 'plain' as const, v: content } };
}

function storedProposalMessage(discussionId: string, seq: number) {
    return { ...storedMessage(discussionId, seq), content: { t: 'plain' as const, v: { kind: 'doc_edit_proposal' as const, proposal: {
        target: { ref: { kind: 'doc' as const, serverId: scope.serverId, artifactId: 'doc-a' }, revision: { headerVersion: 1, bodyVersion: 1 },
            range: { start: 0, end: 6 }, quote: 'Before' }, baseRevision: { headerVersion: 1, bodyVersion: 1 },
        before: 'Before', after: 'After', reason: 'Review' } } } };
}

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Discussion repository', () => {
    it.each(['discussion_read_denied', 'discussion_access_forbidden'])('projects a freshly readable participant thread independently of a retained Home-list %s and still hides a real revocation', async listRefusal => {
        let revoked = false;
        const row = { ...storedSummary('discussion-a'), ownerAccountId: 'other-account', access: 'view' as const,
            capabilities: { ...storedSummary('discussion-a').capabilities, postMessages: false, manageAccess: false } };
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const pathname = new URL(path, 'https://home.invalid').pathname;
            if (pathname === '/v1/discussions') return response({ error: listRefusal }, 403);
            if (revoked) return response({ error: 'discussion_read_denied' }, 403);
            if (pathname === '/v1/discussions/discussion-a') return response({ discussion: { ...row, messageSeq: 4 } });
            if (pathname.endsWith('/participants')) return response({ discussionId: row.id, ownerAccountId: row.ownerAccountId,
                access: 'view', grants: [], participants: [] });
            if (pathname.endsWith('/messages')) return response({ messages: [1, 2, 3, 4].map(seq => storedMessage(row.id, seq)),
                messageSeq: 4, hasMoreOlder: false });
            return response({ error: 'not_found' }, 404);
        }) });
        const hook = await renderHook(() => {
            const snapshot = useDiscussionRepositorySnapshot(repository);
            return { ...selectDiscussionThreadAccessState(snapshot, row.id), thread: snapshot.threads[row.id] };
        });
        try {
            await act(async () => { await repository.refreshList('active'); });
            expect(hook.getCurrent().accessRevoked).toBe(true);
            await act(async () => {
                await expect(repository.participants(row.id)).resolves.toMatchObject({ kind: 'succeeded', value: { access: 'view' } });
                await repository.refreshDiscussion(row.id);
            });
            expect(hook.getCurrent().thread).toMatchObject({ status: 'ready', incomplete: false,
                summary: { access: 'view', capabilities: { postMessages: false } } });
            expect(hook.getCurrent().thread?.messages).toHaveLength(4);
            expect(hook.getCurrent()).toMatchObject({ accessRevoked: false, sourceRefused: false });
            // A resource read does not make the Home query ready or complete.
            expect(repository.getSnapshot().lists.active.status).toBe('revoked');
            revoked = true;
            await act(async () => { await repository.refreshDiscussion(row.id); });
            expect(hook.getCurrent()).toMatchObject({ accessRevoked: true,
                thread: { status: 'revoked', summary: null, messages: [] } });
        } finally { await hook.unmount(); repository.clear(); }
    });
    function docRootHistory(rootKind: 'comment' | 'closed') {
        const root = storedProposalMessage('discussion-a', 1);
        const rootMessage = rootKind === 'closed' ? { ...root, docEditProposalDispositionV1: {
            state: 'declined', decidedBy: { accountId: scope.accountId, atMs: 10 } } }
            : { ...storedMessage('discussion-a', 1), content: { t: 'plain' as const, v: {
                kind: 'doc_passage_comment' as const, passage: root.content.v.proposal.target,
                content: { v: 1, parts: [{ t: 'text', text: 'A passage comment' }] } } } };
        // The real C3 query omits independently withheld Doc rows and fills the
        // page with readable history; sequence contiguity is not a paging fact.
        const rows = Array.from({ length: 100 }, (_, index) => index === 0 ? rootMessage : storedMessage('discussion-a', index + 1))
            .filter(row => row.seq !== 90);
        const requests: URL[] = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            const messageSeq = rows.at(-1)!.seq;
            const row = { ...storedSummary('discussion-a'), messageSeq, latestMessage: {
                ...storedSummary('discussion-a').latestMessage, id: `message-${messageSeq}`, seq: messageSeq } };
            if (url.pathname === '/v1/discussions') return response({ discussions: [{ ...row, anchor: { kind: 'doc', doc: {
                ref: root.content.v.proposal.target.ref, revision: root.content.v.proposal.target.revision } }, firstMessage: rootMessage }], nextCursor: null });
            if (!url.pathname.endsWith('/messages')) return response({ discussion: row });
            requests.push(url);
            const messageId = url.searchParams.get('messageId');
            if (messageId !== null) return response({ messages: rows.filter(message => message.id === messageId), hasMoreOlder: false, messageSeq });
            const after = url.searchParams.get('afterSeq');
            const before = url.searchParams.get('beforeSeq');
            const messages = after !== null ? rows.filter(message => message.seq > Number(after)).slice(0, 20)
                : rows.filter(message => before === null || message.seq < Number(before)).slice(-20);
            return response({ messages, hasMoreOlder: (messages[0]?.seq ?? 1) > 1, messageSeq });
        }) });
        return { repository, requests, rows };
    }

    it.each(['comment', 'closed'] as const)('pages missing history and focuses an older message after a scoped %s root joins a loaded tail', async rootKind => {
        const { repository, requests, rows } = docRootHistory(rootKind);
        await repository.refreshDiscussion('discussion-a');
        const tail = repository.getSnapshot().threads['discussion-a']!.messages;
        expect(tail[0]?.seq).toBe(80);
        expect(tail).toHaveLength(20);
        await repository.readList({ state: 'active', anchorDocArtifactId: 'doc-a' });
        await repository.refreshMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']!.messages.map(row => row.seq)).toEqual([1, ...tail.map(row => row.seq)]);
        expect(repository.getSnapshot().threads['discussion-a']!.messages.at(-1)).toBe(tail.at(-1));
        const readsBeforeFocus = requests.length;
        const focused = await repository.openMessage(message(25).messageRef);
        expect(focused?.seq).toBe(25);
        expect(requests.slice(readsBeforeFocus).map(url => url.search)).toEqual(['?messageId=message-25']);
        expect(repository.getSnapshot().threads['discussion-a']!.messages.map(row => row.seq)).toEqual([1, 25, ...tail.map(row => row.seq)]);
        for (let page = 0; page < 5 && repository.getSnapshot().threads['discussion-a']!.hasMoreOlder; page += 1) {
            await repository.loadOlderMessages('discussion-a');
        }
        expect(repository.getSnapshot().threads['discussion-a']!.messages.map(row => row.seq)).toEqual(rows.map(row => row.seq));
        expect(repository.getSnapshot().threads['discussion-a']!.hasMoreOlder).toBe(false);
        expect(requests.filter(url => url.searchParams.has('beforeSeq')).map(url => Number(url.searchParams.get('beforeSeq')))).toEqual([80, 60, 40, 20]);
    });

    it('keeps cold immutable Doc roots and exact focused rows tail-lazy while retaining missing older history', async () => {
        const { repository, requests } = docRootHistory('comment');
        await repository.readList({ state: 'active', anchorDocArtifactId: 'doc-a' });
        await repository.openMessage(message(25).messageRef);
        await repository.refreshMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']!.messages.map(row => row.seq)).toEqual([
            1, 25, ...Array.from({ length: 21 }, (_, index) => index + 80).filter(seq => seq !== 90),
        ]);
        expect(repository.getSnapshot().threads['discussion-a']!.hasMoreOlder).toBe(true);
        expect(requests.map(url => url.search)).toEqual(['?messageId=message-25', '']);
        await repository.loadOlderMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']!.messages.some(row => row.seq === 60)).toBe(true);
    });

    it('catches up every new history row after an exact focus ahead of the loaded tail', async () => {
        const { repository, requests, rows } = docRootHistory('comment');
        await repository.refreshDiscussion('discussion-a');
        const tail = repository.getSnapshot().threads['discussion-a']!.messages;
        rows.push(...Array.from({ length: 40 }, (_, index) => storedMessage('discussion-a', index + 101)));
        expect((await repository.openMessage(message(140).messageRef))?.seq).toBe(140);
        requests.length = 0;
        await repository.refreshMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']!.messages.map(row => row.seq)).toEqual([
            ...tail.map(row => row.seq), ...Array.from({ length: 40 }, (_, index) => index + 101),
        ]);
        expect(requests.map(url => url.search)).toEqual(['?afterSeq=100', '?afterSeq=120']);
    });

    it('refreshes accepted and declined proposals on older retained pages from the existing Discussion change', async () => {
        const proposal = storedProposalMessage('discussion-a', 3).content.v;
        let decided = false;
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            const stored = storedSummary('discussion-a');
            const row = { ...stored, messageSeq: 8, latestMessage: { ...stored.latestMessage, id: 'message-8', seq: 8 } };
            if (url.pathname === '/v1/discussions') return response({ discussions: url.searchParams.get('state') === 'archived' ? [] : [row], nextCursor: null });
            if (!url.pathname.endsWith('/messages')) return response({ discussion: row });
            const rows = Array.from({ length: 8 }, (_, index) => {
                const seq = index + 1;
                return seq === 3 || seq === 6 ? { ...storedProposalMessage('discussion-a', seq),
                    docEditProposalDispositionV1: !decided ? { state: 'open' } : seq === 3
                        ? { state: 'accepted', acceptedRevision: { headerVersion: 1, bodyVersion: 2 }, decidedBy: { accountId: scope.accountId, atMs: 10 } }
                        : { state: 'declined', decidedBy: { accountId: scope.accountId, atMs: 10 } } } : storedMessage('discussion-a', seq);
            });
            const after = url.searchParams.get('afterSeq');
            const before = url.searchParams.get('beforeSeq');
            const messages = after !== null ? rows.filter(row => row.seq > Number(after)).slice(0, 2)
                : rows.filter(row => before === null || row.seq < Number(before)).slice(-2);
            return response({ messages, hasMoreOlder: (messages[0]?.seq ?? 1) > 1, messageSeq: 8 });
        }) });
        await repository.refreshDiscussion('discussion-a');
        await repository.loadOlderMessages('discussion-a');
        await repository.loadOlderMessages('discussion-a');
        const previous = repository.getSnapshot().threads['discussion-a']!;
        expect(previous.messages.map(row => row.seq)).toEqual([3, 4, 5, 6, 7, 8]);
        expect(previous.hasMoreOlder).toBe(true);
        const unchanged = previous.messages.find(row => row.seq === 4);
        const unmount = repository.mount({ discussionId: 'discussion-a' });
        try {
            decided = true;
            publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: 'discussion-a', changedAt: 10 }] });
            await vi.waitFor(() => expect(repository.getSnapshot().threads['discussion-a']?.messages.filter(row => row.docEditProposalDispositionV1)
                .map(row => row.docEditProposalDispositionV1?.state)).toEqual(['accepted', 'declined']));
            const current = repository.getSnapshot().threads['discussion-a']!;
            expect(current.messages.map(row => row.seq)).toEqual([3, 4, 5, 6, 7, 8]);
            expect(current.hasMoreOlder).toBe(true);
            expect(current.messages.find(row => row.seq === 4)).toBe(unchanged);
            expect(current.messages.filter(row => row.docEditProposalDispositionV1).map(row => row.content)).toEqual([proposal, proposal]);
        } finally { unmount(); }
    });

    it('does not reopen a settled proposal when an older HTTP read finishes after its decision read', async () => {
        let decided = false;
        let pauseRead = false;
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            if (!path.includes('/messages')) return response({ discussion: storedSummary('discussion-a') });
            const disposition = decided ? { state: 'declined', decidedBy: { accountId: scope.accountId, atMs: 10 } } : { state: 'open' };
            const messages = [{ ...storedProposalMessage('discussion-a', 1), docEditProposalDispositionV1: disposition }];
            if (pauseRead) { pauseRead = false; entered.resolve(); await release.promise; }
            return response({ messages, hasMoreOlder: false, messageSeq: 1 });
        }) });
        await repository.refreshDiscussion('discussion-a');
        pauseRead = true;
        const stale = repository.refreshMessages('discussion-a');
        await entered.promise;
        decided = true;
        await repository.refreshMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']?.messages[0]?.docEditProposalDispositionV1?.state).toBe('declined');
        release.resolve();
        await stale;
        expect(repository.getSnapshot().threads['discussion-a']?.messages[0]?.docEditProposalDispositionV1?.state).toBe('declined');
    });

    it('does not restore an unreadable settled root from a delayed open scoped list and recovers through a current authorized read', async () => {
        let settled = false;
        let readable = true;
        let pauseList = false;
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const root = () => ({ ...storedProposalMessage('discussion-a', 1),
            ...(readable ? {} : { content: { t: 'encrypted' as const, c: 'unreadable-with-current-resource-key' } }),
            docEditProposalDispositionV1: settled
                ? { state: 'declined', decidedBy: { accountId: scope.accountId, atMs: 10 } } : { state: 'open' } });
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            if (url.pathname === '/v1/discussions') {
                const row = { ...storedSummary('discussion-a'), anchor: { kind: 'doc', doc: {
                    ref: { kind: 'doc', serverId: scope.serverId, artifactId: 'doc-a' }, revision: { headerVersion: 1, bodyVersion: 1 } } }, firstMessage: root() };
                if (pauseList) { pauseList = false; entered.resolve(); await release.promise; }
                return response({ discussions: [row], nextCursor: null });
            }
            if (url.pathname.endsWith('/messages')) return response({ messages: [root()], hasMoreOlder: false, messageSeq: 1 });
            return response({ discussion: storedSummary('discussion-a') });
        }) });
        const input = { state: 'active' as const, anchorDocArtifactId: 'doc-a' };
        expect((await repository.readList(input)).kind).toBe('succeeded');
        pauseList = true;
        const oldList = repository.readList(input);
        await entered.promise;
        settled = true;
        readable = false;
        await repository.refreshMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']?.summary?.firstMessage).toMatchObject({
            content: null, docEditProposalDispositionV1: { state: 'declined' } });
        expect(JSON.stringify(repository.getSnapshot())).not.toContain('Before');
        release.resolve();
        await oldList;
        expect(JSON.stringify(repository.getSnapshot())).not.toContain('Before');
        readable = true;
        await repository.refreshMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']?.summary?.firstMessage).toMatchObject({
            content: { kind: 'doc_edit_proposal' }, docEditProposalDispositionV1: { state: 'declined' } });
    });

    it('keeps detail backfills separate from list query completion and recovers full membership', async () => {
        let refuseList = false;
        let archived = false;
        let pendingList: Promise<void> | null = null;
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            if (url.pathname === '/v1/discussions') {
                if (refuseList) return response({ error: 'outcome_unknown' }, 503);
                if (pendingList) await pendingList;
                return response({ discussions: url.searchParams.get('state') === 'archived' ? []
                    : [storedSummary('discussion-a'), storedSummary('discussion-b')], nextCursor: null });
            }
            if (url.pathname.endsWith('/messages')) return response({ messages: [storedMessage('discussion-a', 1)], hasMoreOlder: false, messageSeq: 1 });
            return response({ discussion: { ...storedSummary('discussion-a'), archivedAt: archived ? 1 : null } });
        }) });

        // A phone opens a selected thread before its Home list is demanded.
        await repository.refreshDiscussion('discussion-a');
        expect(repository.getSnapshot().lists.active).toMatchObject({ status: 'idle', items: [{ id: 'discussion-a' }] });
        await repository.refreshList('active');
        expect(repository.getSnapshot().lists.active).toMatchObject({ status: 'ready', items: [{ id: 'discussion-a' }, { id: 'discussion-b' }] });
        await repository.refreshDiscussion('discussion-a');
        expect(repository.getSnapshot().lists.active.status).toBe('ready');
        expect(repository.getSnapshot().lists.active.items).toHaveLength(2);

        refuseList = true;
        await repository.refreshList('active');
        const failed = repository.getSnapshot().lists.active;
        expect(failed.status).not.toBe('ready');
        await repository.refreshDiscussion('discussion-a');
        expect(repository.getSnapshot().lists.active).toMatchObject({ status: failed.status, errorCode: failed.errorCode });

        refuseList = false;
        const responseReady = createDeferred<void>();
        pendingList = responseReady.promise;
        const refreshing = repository.refreshList('active');
        await repository.refreshDiscussion('discussion-a');
        expect(repository.getSnapshot().lists.active.status).toBe('loading');
        responseReady.resolve();
        await refreshing;
        expect(repository.getSnapshot().lists.active).toMatchObject({ status: 'ready', errorCode: null,
            items: [{ id: 'discussion-a' }, { id: 'discussion-b' }] });
        expect(repository.getSnapshot().archivedExistence).toBe('empty');
        archived = true;
        await repository.refreshDiscussion('discussion-a');
        expect(repository.getSnapshot().lists.active).toMatchObject({ status: 'ready', items: [{ id: 'discussion-b' }] });
        expect(repository.getSnapshot().lists.archived).toMatchObject({ status: 'idle', items: [{ id: 'discussion-a' }] });
        expect(repository.getSnapshot().archivedExistence).toBe('present');
    });

    it('opens only the exact qualified root and hides it when its Doc source becomes unavailable', async () => {
        const root = storedMessage('discussion-a', 1);
        let denied = false;
        const requests: string[] = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async (path) => {
            requests.push(path);
            if (denied) return response({ error: 'discussion_content_unavailable' }, 409);
            if (path === '/v1/discussions/discussion-a') return response({ discussion: { ...storedSummary('discussion-a'), messageSeq: 3 } });
            const url = new URL(path, 'https://home.invalid');
            return response({ messages: url.searchParams.get('messageId') === root.id ? [root] : [storedMessage('discussion-a', 3)],
                hasMoreOlder: false, messageSeq: 3 });
        }) });
        const ref = createDiscussionMessageRefV1({ ...address, discussionId: 'discussion-a' }, root);
        expect(await repository.openMessage(ref)).toMatchObject({ id: root.id, messageRef: ref });
        expect(requests.filter(path => path.includes('/messages'))).toEqual(['/v1/discussions/discussion-a/messages?messageId=message-1']);
        expect(repository.getSnapshot().threads['discussion-a']?.messages).toHaveLength(1);
        const count = requests.length;
        expect(await repository.openMessage({ ...ref, discussion: { ...ref.discussion, serverId: 'other-home' } })).toBeNull();
        expect(requests).toHaveLength(count);
        denied = true;
        expect(await repository.openMessage(ref)).toBeNull();
        expect(repository.getSnapshot().threads['discussion-a']?.messages).toEqual([]);
    });

    it('projects a Home collection refusal to existing and newly demanded anchor collections', async () => {
        let denied = false;
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async () => denied
            ? response({ error: 'discussion_read_denied' }, 403)
            : response({ discussions: [{ ...storedSummary('discussion-a'), anchor: { kind: 'session', sessionId: 'anchor-a' } }], nextCursor: null })) });
        await repository.refreshAnchoredList('anchor-a', 'active');
        expect(repository.getListSnapshot('anchor-a').lists.active.items.map(row => row.id)).toEqual(['discussion-a']);
        denied = true;
        await repository.refreshAnchoredList('anchor-a', 'active');
        for (const anchor of ['anchor-a', 'anchor-new']) {
            expect(repository.getListSnapshot(anchor)).toMatchObject({
                lists: { active: { items: [], status: 'revoked', errorCode: 'discussion_read_denied' },
                    archived: { items: [], status: 'revoked', errorCode: 'discussion_read_denied' } },
                archivedExistence: 'unknown',
            });
        }
    });

    it('projects ownership changes and retires only the resource left through real management HTTP', async () => {
        let ownerAccountId: string = scope.accountId;
        let left = false;
        const roster = () => ({ discussionId: 'discussion-a', ownerAccountId, access: ownerAccountId === scope.accountId ? 'owner' : 'admin',
            grants: [{ principal: { kind: 'account', accountId: 'account-b' }, accessLevel: 'edit',
                createdByAccountId: scope.accountId, createdAt: 1, display: { name: 'B' } }] });
        const currentSummary = () => ({ ...storedSummary('discussion-a'), ownerAccountId,
            access: ownerAccountId === scope.accountId ? 'owner' : 'admin', capabilities: { ...storedSummary('discussion-a').capabilities,
                leave: ownerAccountId !== scope.accountId } });
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async (path, init) => {
            const url = new URL(path, 'https://home.invalid');
            if (url.pathname === '/v1/discussions') return response({ discussions: url.searchParams.get('state') === 'archived' ? []
                : [...(left ? [] : [currentSummary()]), storedSummary('discussion-b')], nextCursor: null });
            if (path.endsWith('/leave')) { left = true; return response({ discussionId: 'discussion-a', access: null, changed: true }); }
            if (left) return response({ error: 'discussion_not_found' }, 404);
            if (path.endsWith('/owner') && init?.method === 'PUT') { ownerAccountId = 'account-b'; return response({ ...roster(), changed: true }); }
            if (path.endsWith('/participants')) return response({ ...roster(), participants: [] });
            if (path.endsWith('/access/grants')) return response(roster());
            if (path.endsWith('/messages')) return response({ messages: [storedMessage('discussion-a', 1)], hasMoreOlder: false, messageSeq: 1 });
            return response({ discussion: currentSummary() });
        }) });
        await repository.refreshList('active');
        expect(await repository.participants('discussion-a')).toMatchObject({ kind: 'succeeded', value: { access: 'owner' } });
        expect(await repository.transferOwner({ discussionId: 'discussion-a', accountId: 'account-b' })).toMatchObject({ kind: 'succeeded', value: { changed: true } });
        expect(repository.getSnapshot().lists.active.items.find(row => row.id === 'discussion-a'))
            .toMatchObject({ ownerAccountId: 'account-b', access: 'admin', capabilities: { leave: true } });
        expect(await repository.leave('discussion-a')).toMatchObject({ kind: 'succeeded', value: { access: null } });
        expect(repository.getSnapshot().lists.active.items.map(row => row.id)).toEqual(['discussion-b']);
        expect(repository.getSnapshot().threads['discussion-a']).toMatchObject({ summary: null, messages: [], status: 'revoked' });
        expect(await repository.listGrants('discussion-a')).toMatchObject({ kind: 'failed', errorCode: 'discussion_not_found' });
    });

    it('changes an executable participant answer policy through the existing Action HTTP contract and fences revoked reads', async () => {
        let answerPolicy = 'when_addressed';
        let revoked = false;
        const roster = () => ({ discussionId: 'discussion-a', ownerAccountId: scope.accountId, access: 'owner', grants: [] });
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async (path, init) => {
            if (revoked) return response({ error: 'discussion_read_denied' }, 403);
            if (path.endsWith('/participants/policy')) {
                const body = JSON.parse(String(init?.body));
                expect(body.participant).toEqual({ kind: 'session', sessionId: 'agent-session' });
                answerPolicy = body.answerPolicy;
                return response({ ...roster(), changed: true });
            }
            if (path.endsWith('/participants')) return response({ ...roster(), participants: [{
                participant: { kind: 'session', sessionId: 'agent-session' }, answerPolicy, createdAt: 1,
            }] });
            return response({ discussion: storedSummary('discussion-a') });
        }) });
        expect(await repository.setParticipantPolicy({ discussionId: 'discussion-a',
            participant: { kind: 'session', sessionId: 'agent-session' }, answerPolicy: 'reads_only' }))
            .toMatchObject({ kind: 'succeeded', value: { changed: true } });
        expect(await repository.participants('discussion-a')).toMatchObject({ kind: 'succeeded', value: {
            participants: [{ answerPolicy: 'reads_only' }],
        } });
        revoked = true;
        expect(await repository.setParticipantPolicy({ discussionId: 'discussion-a',
            participant: { kind: 'session', sessionId: 'agent-session' }, answerPolicy: 'when_addressed' }))
            .toMatchObject({ kind: 'failed', errorCode: 'discussion_read_denied' });
        expect(repository.getSnapshot().threads['discussion-a']).toMatchObject({ status: 'revoked', summary: null });
    });

    it.each([{ firstMessageSeq: 1, abort: false }, { firstMessageSeq: 2, abort: false }, { firstMessageSeq: 1, abort: true }])('reconciles a lost create through its creator-qualified atomic first message (seq $firstMessageSeq, abort $abort)', async ({ firstMessageSeq, abort }) => {
        const creationLocalId = 'same-creator-local-id';
        const messageLocalId = 'same-message-local-id';
        const own = { ...storedSummary('discussion-a'), creationLocalId };
        const foreign = { ...storedSummary('discussion-foreign'), creationLocalId };
        const messageReads: URL[] = [];
        const creationIds: string[] = [];
        let committed = false;
        const controller = new AbortController();
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async (path, init) => {
            const url = new URL(path, 'https://home.invalid');
            if (url.pathname === '/v1/discussions' && init?.method === 'POST') {
                creationIds.push(DiscussionCreateRequestV1Schema.parse(JSON.parse(String(init.body))).creationLocalId);
                if (abort && committed) return response({ discussion: own, firstMessage: {
                    ...storedMessage(own.id, 1), localId: messageLocalId,
                } });
                committed = true;
                if (abort) { controller.abort(); throw new DOMException('Response aborted after commit', 'AbortError'); }
                throw new TypeError('create response lost after commit');
            }
            if (url.pathname === '/v1/discussions') return response({ discussions: !committed || url.searchParams.get('state') === 'archived' ? []
                : url.searchParams.get('creationLocalId') === creationLocalId ? [own] : [foreign, own], nextCursor: null });
            const discussionId = url.pathname.split('/')[3]!;
            if (url.pathname.endsWith('/messages')) {
                messageReads.push(url);
                return response({ messages: [{ ...storedMessage(discussionId, firstMessageSeq), localId: messageLocalId }],
                    hasMoreOlder: false, messageSeq: firstMessageSeq });
            }
            return response({ discussion: discussionId === own.id ? own : foreign });
        }) });
        expect(await repository.create({ creationLocalId, messageLocalId, title: 'Mine',
            content: { v: 1, parts: [{ t: 'text', text: 'Mine' }] }, draftSubmission: draftSubmission() }, controller.signal)).toMatchObject({ kind: 'checking' });
        if (abort) {
            await vi.waitFor(() => expect(repository.getSnapshot().mutations[creationLocalId]?.status).toBe('outcome_unknown'));
            expect(repository.getSnapshot().mutations[creationLocalId]).toMatchObject({ localId: creationLocalId, messageLocalId });
            await repository.retry(creationLocalId);
        }
        await vi.waitFor(() => expect(repository.getSnapshot().mutations[creationLocalId]?.status).toBe(firstMessageSeq === 1 ? 'observed_success' : 'outcome_unknown'));
        expect(messageReads.map(url => url.search)).toEqual(abort ? [] : [`?localId=${messageLocalId}`]);
        expect(creationIds).toEqual(abort ? [creationLocalId, creationLocalId] : [creationLocalId]);
        expect(repository.getSnapshot().mutations[creationLocalId]?.discussionId).toBe(firstMessageSeq === 1 ? own.id : undefined);
        expect(repository.getSnapshot().threads[foreign.id]).toBeUndefined();
    });

    it('retains an uncertain create with initial people until its original key-delivery lifecycle is retried', async () => {
        const secret = new Uint8Array(32).fill(17);
        const encryption = await Encryption.create(secret);
        const ownerContentPublicKeyFingerprint = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
            material: { type: 'legacy', secret } }).contentPublicKeyFingerprint;
        let stored: DiscussionCreateResponseV1 | null = null;
        let preparationAvailable = false;
        const creates: DiscussionCreateRequestV1[] = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async (path, init) => {
            const url = new URL(path, 'https://home.invalid');
            if (url.pathname === '/v1/discussions' && init?.method === 'GET') return response({
                discussions: stored && url.searchParams.get('state') !== 'archived' ? [stored.discussion] : [], nextCursor: null });
            if (url.pathname === '/v1/discussions' && init?.method === 'POST') {
                const body = DiscussionCreateRequestV1Schema.parse(JSON.parse(String(init.body)));
                creates.push(body);
                stored ??= { discussion: { ...storedSummary('discussion-a'), encryptionMode: 'e2ee', keyReadiness: true,
                    dataEncryptionKey: body.dataEncryptionKey!, creationLocalId: body.creationLocalId, titleContent: body.titleContent },
                    firstMessage: { ...storedMessage('discussion-a', 1), content: body.firstMessage.content,
                        localId: body.firstMessage.localId, mentionedAccountIds: body.firstMessage.mentionedAccountIds ?? [] } };
                return response(stored);
            }
            if (url.pathname.endsWith('/data-key/recipients')) return preparationAvailable
                ? response({ discussionId: 'discussion-a', ownerAccountId: scope.accountId, access: 'owner', encryptionMode: 'e2ee',
                    dataEncryptionKey: stored?.discussion.dataEncryptionKey, callerDataEncryptionKey: stored?.discussion.dataEncryptionKey, recipients: [] })
                : response({ error: 'discussion_content_unavailable' }, 503);
            if (url.pathname.endsWith('/messages')) return response({ messages: stored ? [stored.firstMessage] : [], hasMoreOlder: false, messageSeq: 1 });
            return response({ discussion: stored?.discussion });
        }, { encryption, accountMode: 'e2ee', ownerContentPublicKeyFingerprint }) });
        const outcome = await repository.create({ creationLocalId: 'create-with-people', messageLocalId: 'first-message',
            title: 'Together', content: { v: 1, parts: [{ t: 'text', text: 'Hello' }] },
            participants: [{ kind: 'account', accountId: 'account-b' }], draftSubmission: draftSubmission() });
        expect(outcome.kind).toBe('checking');
        await vi.waitFor(() => expect(repository.getSnapshot().mutations['create-with-people']?.status).not.toBe('checking'));
        expect(repository.getSnapshot().mutations['create-with-people']?.status).toBe('outcome_unknown');
        preparationAvailable = true;
        expect(await repository.retry('create-with-people')).toMatchObject({ kind: 'succeeded', value: { discussion: { id: 'discussion-a' } } });
        expect(creates).toHaveLength(2);
        expect(creates[1]?.dataEncryptionKey).toBe(creates[0]?.dataEncryptionKey);
        expect(creates[1]?.creationLocalId).toBe('create-with-people');
        expect(creates[1]?.firstMessage.localId).toBe('first-message');
    });

    it('retires only the denied resource and keeps an unrelated Home HTTP read current', async () => {
        const oldA = createDeferred<void>();
        const currentB = createDeferred<void>();
        const oldList = createDeferred<void>();
        const listArrived = createDeferred<void>();
        let pendingReads = false;
        let pendingList = false;
        let denied = false;
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async (path) => {
            const url = new URL(path, 'https://home.invalid');
            if (url.pathname === '/v1/discussions') {
                if (url.searchParams.get('state') === 'archived') return response({ discussions: [], nextCursor: null });
                if (url.searchParams.get('cursor')) {
                    if (pendingList) { listArrived.resolve(); await oldList.promise; }
                    return response({ discussions: [storedSummary('discussion-b')], nextCursor: null });
                }
                return response({ discussions: [storedSummary('discussion-a')], nextCursor: 'home-page-2' });
            }
            const discussionId = url.pathname.split('/')[3]!;
            if (!url.pathname.endsWith('/messages')) return response({ discussion: storedSummary(discussionId) });
            if (discussionId === 'discussion-a' && denied) return response({ error: 'discussion_read_denied' }, 403);
            const seq = pendingReads ? 2 : 1;
            if (pendingReads) await (discussionId === 'discussion-a' ? oldA : currentB).promise;
            return response({ messages: [storedMessage(discussionId, seq)], hasMoreOlder: false, messageSeq: seq });
        }) });
        await repository.refreshList('active');
        await repository.loadMoreList('active');
        await repository.refreshMessages('discussion-a');
        await repository.refreshMessages('discussion-b');
        expect(repository.getSnapshot().threads['discussion-b']?.messages).toHaveLength(1);
        pendingReads = true;
        const staleRead = repository.refreshMessages('discussion-a');
        const neighborRead = repository.refreshMessages('discussion-b');
        pendingList = true;
        const staleList = repository.refreshList('active');
        await listArrived.promise;
        denied = true;
        await repository.refreshMessages('discussion-a');
        oldA.resolve();
        currentB.resolve();
        oldList.resolve();
        await Promise.all([staleRead, neighborRead, staleList]);
        const snapshot = repository.getSnapshot();
        expect(snapshot.lists.active.items.map(row => row.id)).toEqual(['discussion-b']);
        expect(snapshot.threads['discussion-a']?.messages ?? []).toEqual([]);
        expect(snapshot.threads['discussion-b']).toMatchObject({ status: 'ready', messageSeq: 2 });
        expect(snapshot.threads['discussion-b']?.messages.map(row => row.seq)).toEqual([1, 2]);
    });

    it('reads an anchored projection past an unrelated first Home page through the same HTTP repository', async () => {
        const anchored = { ...storedSummary('matching'), anchor: { kind: 'session', sessionId: 'anchor-a' } };
        const reads: string[] = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            reads.push(path);
            if (url.pathname === '/v1/discussions/matching') return response({ discussion: anchored });
            const filtered = url.searchParams.get('anchorSessionId') === 'anchor-a';
            if (url.searchParams.get('anchorSessionId') === 'anchor-b') return response({ discussions: [], nextCursor: null });
            if (url.searchParams.get('state') === 'archived') return response({ discussions: filtered ? [{ ...anchored, id: 'archived', archivedAt: 20 }] : [], nextCursor: null });
            return response({ discussions: filtered ? [{ ...anchored, id: url.searchParams.get('cursor') ? 'matching-page-2' : anchored.id }]
                : [storedSummary('unrelated')], nextCursor: filtered ? url.searchParams.get('cursor') ? null : 'anchor-page-2' : 'home-page-2' });
        }) });
        await repository.refreshList('active');
        await repository.refreshList('active', undefined, 'anchor-a');
        expect(repository.getListSnapshot('anchor-a')).toMatchObject({ lists: { active: {
            items: [expect.objectContaining({ id: 'matching' })], nextCursor: 'anchor-page-2', status: 'ready',
        } } });
        await repository.loadMoreAnchoredList('anchor-a', 'active');
        await repository.refreshAnchoredList('anchor-a', 'archived');
        expect(repository.getListSnapshot('anchor-a').lists.active.items.map(row => row.id)).toEqual(['matching', 'matching-page-2']);
        expect(repository.getListSnapshot('anchor-a').lists.archived.items.map(row => row.id)).toEqual(['archived']);
        expect(repository.getSnapshot().lists.active.items.map(row => row.id)).toEqual(['unrelated']);
        const releaseOld = repository.mount({ anchorSessionId: 'anchor-a' });
        releaseOld();
        const releaseCurrent = repository.mount({ anchorSessionId: 'anchor-b' });
        reads.length = 0;
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: 'matching', changedAt: 1 }] });
        await vi.waitFor(() => expect(repository.getSnapshot().threads.matching?.summary?.id).toBe('matching'));
        await flushHookEffects();
        expect(repository.getListSnapshot('anchor-b').lists.active.status).toBe('idle');
        expect(reads).toEqual(['/v1/discussions/matching']);
        releaseCurrent();
    });

    it('shares one Home repository across optional Session anchors while keeping Accounts and Homes isolated', () => {
        clearDiscussionRepositoryRegistryForTests();
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const first = getDiscussionRepository({ scope, address, client: client() });
        const otherAnchor = getDiscussionRepository({
            scope,
            address: { ...address },
            client: client(),
        });
        const otherAccount = getDiscussionRepository({
            scope: { ...scope, accountId: 'account-b' }, address, client: client(),
        });
        const otherHome = getDiscussionRepository({
            scope: { ...scope, serverId: 'home-b' },
            address: { ...address, serverId: 'home-b' }, client: client(),
        });

        expect(otherAnchor).toBe(first);
        expect(otherAccount).not.toBe(first);
        expect(otherHome).not.toBe(first);
        clearDiscussionRepositoryRegistryForTests();
    });

    it('publishes one stable optimistic message payload before a post settles', async () => {
        let resolvePost: (value: Awaited<ReturnType<DiscussionRepositoryClient['post']>>) => void = () => {
            throw new Error('post resolver was not installed');
        };
        const post = vi.fn<DiscussionRepositoryClient['post']>(() => new Promise((resolve) => {
            resolvePost = resolve;
        }));
        const repository = createDiscussionRepository({ scope, address, client: client({ post }) });
        const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Visible now' }] };

        const pending = repository.post({
            discussionId: 'discussion-a',
            localId: 'post-local-pending',
            content,
            mentionedAccountIds: ['account-b'],
            draftSubmission: draftSubmission('discussion'),
        });

        expect(repository.getSnapshot().mutations['post-local-pending']).toMatchObject({
            localId: 'post-local-pending',
            discussionId: 'discussion-a',
            status: 'sending',
            content,
            mentionedAccountIds: ['account-b'],
        });

        resolvePost({
            kind: 'succeeded',
            value: {
                v: 1,
                serverId: address.serverId,
                
                message: { ...message(1, 'post-local-pending'), content },
                messageSeq: 1,
            },
        });
        await pending;

        const snapshot = repository.getSnapshot();
        expect(snapshot.mutations['post-local-pending']?.status).toBe('observed_success');
        expect(snapshot.threads['discussion-a']?.messages.filter((row) => row.localId === 'post-local-pending')).toHaveLength(1);
    });

    it('purges the denied Discussion projections and mutations on explicit access loss', async () => {
        const list = vi.fn<DiscussionRepositoryClient['list']>()
            .mockResolvedValue({ kind: 'succeeded', value: listResult([summary('discussion-a', null, 1)], null) });
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValueOnce({ kind: 'succeeded', value: readResult([message(1)], false, 1) })
            .mockResolvedValueOnce({ kind: 'failed', errorCode: 'discussion_read_denied' });
        const post = vi.fn<DiscussionRepositoryClient['post']>()
            .mockResolvedValue({ kind: 'approval_request_created', artifactId: 'approval-a', actionId: 'discussion.post' });
        const repository = createDiscussionRepository({ scope, address, client: client({ list, read, post }) });
        await repository.refreshList('active');
        await repository.refreshMessages('discussion-a');
        await repository.post({
            discussionId: 'discussion-a',
            localId: 'post-local-a',
            content: { v: 1, parts: [{ t: 'text', text: 'Private pending text' }] },
            draftSubmission: draftSubmission('discussion'),
        });

        await repository.refreshMessages('discussion-a');

        expect(repository.getSnapshot()).toMatchObject({
            lists: {
                active: { items: [], status: 'ready', errorCode: null },
                archived: { items: [], status: 'idle', errorCode: null },
            },
            threads: { 'discussion-a': { summary: null, messages: [], status: 'revoked', errorCode: 'discussion_read_denied' } },
            mutations: {},
        });
    });

    it('purges retained decrypted state when a protected refresh nondiscloses the discussion as not found', async () => {
        const list = vi.fn<DiscussionRepositoryClient['list']>()
            .mockResolvedValue({ kind: 'succeeded', value: listResult([summary('discussion-a', null, 1)], null) });
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValue({ kind: 'succeeded', value: readResult([message(1)], false, 1) });
        const get = vi.fn<DiscussionRepositoryClient['get']>()
            .mockResolvedValueOnce({
                kind: 'succeeded',
                value: {
                    v: 1,
                    serverId: address.serverId,
                    
                    discussion: summary('discussion-a', null, 1),
                },
            })
            .mockResolvedValueOnce({ kind: 'failed', errorCode: 'discussion_not_found' });
        const repository = createDiscussionRepository({ scope, address, client: client({ list, read, get }) });
        await repository.refreshList('active');
        await repository.refreshDiscussion('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']?.messages).toHaveLength(1);

        await repository.refreshDiscussion('discussion-a');

        expect(repository.getSnapshot()).toMatchObject({
            lists: {
                active: { items: [], status: 'ready', errorCode: null },
                archived: { items: [], status: 'idle', errorCode: null },
            },
            threads: { 'discussion-a': { summary: null, messages: [], status: 'revoked', errorCode: 'discussion_not_found' } },
            mutations: {},
        });
    });

    it('retains recoverable projections across a transient list failure', async () => {
        const retained = summary('discussion-a', null, 1);
        // Each active refresh also asks the bounded archived-existence probe.
        const activeOutcomes: Awaited<ReturnType<DiscussionRepositoryClient['list']>>[] = [
            { kind: 'succeeded', value: listResult([retained], null) },
            { kind: 'failed', errorCode: 'offline' },
        ];
        const list = vi.fn<DiscussionRepositoryClient['list']>(async (input) => (
            input?.state === 'archived'
                ? { kind: 'succeeded', value: listResult([], null) }
                : activeOutcomes.shift()!
        ));
        const repository = createDiscussionRepository({ scope, address, client: client({ list }) });

        await repository.refreshList('active');
        await repository.refreshList('active');

        expect(repository.getSnapshot().lists.active).toMatchObject({
            items: [retained],
            status: 'offline',
            errorCode: 'offline',
        });
    });

    it('does not let an older in-flight success repopulate state after access loss', async () => {
        let resolveRead: (value: Awaited<ReturnType<DiscussionRepositoryClient['read']>>) => void = () => {
            throw new Error('read resolver was not installed');
        };
        const read = vi.fn<DiscussionRepositoryClient['read']>(() => new Promise((resolve) => {
            resolveRead = resolve;
        }));
        const list = vi.fn<DiscussionRepositoryClient['list']>()
            .mockResolvedValue({ kind: 'failed', errorCode: 'discussion_read_denied' });
        const repository = createDiscussionRepository({ scope, address, client: client({ list, read }) });

        const staleRefresh = repository.refreshMessages('discussion-a');
        await repository.refreshList('active');
        resolveRead({ kind: 'succeeded', value: readResult([message(1)], false, 1) });
        await staleRefresh;

        expect(repository.getSnapshot()).toMatchObject({
            lists: { active: { status: 'revoked' }, archived: { status: 'revoked' } },
            threads: {},
        });
    });

    it.each(['active', 'archived'] as const)('completes the selected %s corpus for client search through existing HTTP keyset pages', async state => {
        const requests: URL[] = [];
        const row = (id: string) => ({ ...storedSummary(id), archivedAt: state === 'archived' ? 20 : null });
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            requests.push(url);
            if (url.searchParams.get('state') !== state) return response({ discussions: [], nextCursor: null });
            const cursor = url.searchParams.get('cursor');
            return response(cursor === 'page-3'
                ? { discussions: [row('last-page-match')], nextCursor: null }
                : cursor === 'page-2'
                    ? { discussions: [row('middle')], nextCursor: 'page-3' }
                    : { discussions: [row('first')], nextCursor: 'page-2' });
        }) });
        await repository.refreshList(state, undefined, undefined, { complete: true });
        expect(repository.getSnapshot().lists[state].items.map(row => row.id)).toEqual(['first', 'middle', 'last-page-match']);
        expect(repository.getSnapshot().lists[state]).toMatchObject({ status: 'ready', nextCursor: null, incomplete: false });
        expect(requests.filter(url => url.searchParams.get('state') === state).map(url => url.searchParams.get('cursor')))
            .toEqual([null, 'page-2', 'page-3']);
        expect(requests.every(url => [...url.searchParams.keys()].every(key => ['state', 'cursor', 'limit'].includes(key)))).toBe(true);
    });

    it('keeps received search pages visible with the real next frontier when a later page fails', async () => {
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            if (url.searchParams.get('state') === 'archived') return response({ discussions: [], nextCursor: null });
            return url.searchParams.has('cursor') ? response({ error: 'temporary_failure' }, 503)
                : response({ discussions: [storedSummary('known-match')], nextCursor: 'unread-page' });
        }) });
        await repository.refreshList('active', undefined, undefined, { complete: true });
        expect(repository.getSnapshot().lists.active).toMatchObject({
            items: [{ id: 'known-match' }], status: 'error', nextCursor: 'unread-page',
        });
        expect(selectDiscussionListSearch(repository.getSnapshot().lists.active, 'known-match', new Map())).toMatchObject({
            items: [{ id: 'known-match' }], status: 'error', nextCursor: 'unread-page', incomplete: true,
        });
    });

    it('keeps a normal joined page read when its search caller cancels and resumes the same frontier', async () => {
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const requests: string[] = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            if (url.searchParams.get('state') === 'archived') return response({ discussions: [], nextCursor: null });
            requests.push(url.searchParams.get('cursor') ?? 'first');
            if (!url.searchParams.has('cursor')) { entered.resolve(); await release.promise; }
            return response({ discussions: [storedSummary(url.searchParams.has('cursor') ? 'last' : 'first')],
                nextCursor: url.searchParams.has('cursor') ? null : 'later-page' });
        }) });
        const search = new AbortController();
        const completing = repository.loadCompleteList('active', search.signal);
        await entered.promise;
        const visibleRead = repository.refreshList('active');
        search.abort();
        release.resolve();
        await Promise.all([completing, visibleRead]);
        expect(repository.getSnapshot().lists.active).toMatchObject({ status: 'ready', items: [{ id: 'first' }], nextCursor: 'later-page' });
        expect(requests).toEqual(['first']);
        await repository.loadCompleteList('active');
        expect(repository.getSnapshot().lists.active.items.map(row => row.id)).toEqual(['first', 'last']);
        expect(requests).toEqual(['first', 'later-page']);
        const snapshot = repository.getSnapshot();
        await repository.loadCompleteList('active');
        expect(repository.getSnapshot()).toBe(snapshot);
    });

    it.each(['active', 'archived'] as const)('repairs %s list readability when exact summaries open after key delivery', async state => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(37));
        const key = await createResourceDataKey({ mode: 'e2ee', encryptDataEncryptionKey: value => encryption.encryptEncryptionKey(value) });
        if (!key || key.mode !== 'e2ee') throw new Error('Expected resource key fixture');
        const title = await sealSessionStoredContent(resourceStoredContentContext(key), { v: 1, title: 'Release discussion' });
        const body = await sealSessionStoredContent(resourceStoredContentContext(key), { v: 1, parts: [{ t: 'text', text: 'Ready for review' }] });
        if (title.status !== 'ready' || body.status !== 'ready') throw new Error('Expected sealed resource fixture');
        const anchorSessionId = state === 'active' ? 'source' : undefined;
        const ready = new Set<string>();
        const rows = ['discussion-a', 'discussion-b'].map((id, index) => ({ ...storedSummary(id),
            anchor: { kind: 'session' as const, sessionId: 'source' },
            archivedAt: state === 'archived' ? 1 : null,
            encryptionMode: 'e2ee' as const, dataEncryptionKey: key.dataEncryptionKey, titleContent: title.content,
            latestMessage: { ...storedSummary(id).latestMessage, createdAt: 1000 - index, content: body.content },
        }));
        const requests: string[] = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            requests.push(url.pathname);
            const project = (row: typeof rows[number]) => ({ ...row, keyReadiness: ready.has(row.id) });
            if (url.pathname === '/v1/discussions') return response({
                discussions: url.searchParams.get('state') === state ? rows.map(project) : [], nextCursor: 'unread-page',
            });
            const row = rows.find(row => url.pathname.endsWith(`/${row.id}`));
            if (!row) throw new Error('Unexpected Discussion request');
            return response({ discussion: project(row) });
        }, { encryption, accountMode: 'e2ee' }) });
        const list = () => anchorSessionId === undefined ? repository.getSnapshot().lists[state]
            : repository.getListSnapshot(anchorSessionId).lists[state];
        if (anchorSessionId === undefined) await repository.refreshList(state);
        else await repository.refreshAnchoredList(anchorSessionId, state);
        expect(list()).toMatchObject({ status: 'locked', incomplete: true, nextCursor: 'unread-page' });
        requests.length = 0;

        ready.add('discussion-a');
        await repository.refreshSummary('discussion-a');
        expect(list()).toMatchObject({ status: 'locked', incomplete: true });
        expect(list().items.find(row => row.id === 'discussion-a')).toMatchObject({ title: 'Release discussion',
            latestMessage: { content: { parts: [{ text: 'Ready for review' }] } } });

        ready.add('discussion-b');
        await repository.refreshSummary('discussion-b');
        expect(list()).toMatchObject({ status: 'ready', incomplete: false, nextCursor: 'unread-page' });
        expect(list().items.map(row => row.id)).toEqual(['discussion-a', 'discussion-b']);
        // Exact key recovery changes row readability, not query membership or paging demand.
        expect(requests).toEqual(['/v1/discussions/discussion-a', '/v1/discussions/discussion-b']);
        repository.clear();
    });

    it('searches a later-page title opened by the actual resource cipher, never ciphertext or message bodies', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(37));
        const key = await createResourceDataKey({ mode: 'e2ee', encryptDataEncryptionKey: value => encryption.encryptEncryptionKey(value) });
        if (!key || key.mode !== 'e2ee') throw new Error('Expected resource key fixture');
        const title = await sealSessionStoredContent(resourceStoredContentContext(key), { v: 1, title: 'Private payroll review' });
        const body = await sealSessionStoredContent(resourceStoredContentContext(key), { v: 1, parts: [{ t: 'text', text: 'body-only-needle' }] });
        if (title.status !== 'ready' || title.content.t !== 'encrypted' || body.status !== 'ready') throw new Error('Expected sealed resource fixture');
        const opened = { ...storedSummary('opened-title'), encryptionMode: 'e2ee', dataEncryptionKey: key.dataEncryptionKey,
            titleContent: title.content, latestMessage: { ...storedSummary('opened-title').latestMessage, content: body.content } };
        const locked = { ...opened, id: 'locked-title', keyReadiness: false };
        const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async (path, init) => {
            const url = new URL(path, 'https://home.invalid');
            requests.push({ url, init });
            return response({ discussions: url.searchParams.get('state') === 'archived' ? []
                : url.searchParams.has('cursor') ? [opened] : [locked],
                nextCursor: url.searchParams.get('state') === 'archived' || url.searchParams.has('cursor') ? null : 'encrypted-page-2' });
        }, { encryption, accountMode: 'e2ee' }) });
        await repository.loadCompleteList('active');
        const list = repository.getSnapshot().lists.active;
        expect(list.items.map(row => row.title)).toEqual([null, 'Private payroll review']);
        const selected = selectDiscussionListSearch(list, 'PAYROLL', new Map());
        expect(selected.items.map(row => row.id)).toEqual(['opened-title']);
        expect(selected).toMatchObject({ status: 'locked', nextCursor: null, incomplete: true });
        expect(selectDiscussionListSearch(list, title.content.c, new Map()).items).toEqual([]);
        expect(selectDiscussionListSearch(list, 'body-only-needle', new Map()).items).toEqual([]);
        expect(requests.every(({ url, init }) => init?.method === 'GET' && init.body === undefined
            && [...url.searchParams.keys()].every(name => ['state', 'cursor', 'limit'].includes(name)))).toBe(true);
    });

    it('does not index a former participant by retained profile identity', () => {
        const row = { ...summary('former-participant', null, 1), participantAccounts: [{
            v: 1 as const, accountId: 'former', accessibility: 'former' as const,
            profile: { name: 'Retained Person', firstName: 'Retained', lastName: 'Person', username: 'retained', avatarUrl: null },
        }] };
        const list = { items: [row], nextCursor: null, status: 'ready' as const, errorCode: null, incomplete: false };

        expect(selectDiscussionListSearch(list, 'Retained Person', new Map()).items).toEqual([]);
        expect(selectDiscussionListSearch(list, 'retained', new Map()).items).toEqual([]);
    });

    it('does not publish a later search page or continue traversal after Home retirement', async () => {
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const cursors: Array<string | null> = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            const cursor = url.searchParams.get('cursor');
            cursors.push(cursor);
            if (cursor) { entered.resolve(); await release.promise; }
            return response({ discussions: [storedSummary(cursor ? 'retired-private' : 'first')], nextCursor: cursor ? 'must-not-read' : 'later-page' });
        }) });
        const completing = repository.loadCompleteList('active');
        await entered.promise;
        repository.clear();
        const retired = repository.getSnapshot();
        release.resolve();
        await completing;
        expect(repository.getSnapshot()).toBe(retired);
        expect(repository.getSnapshot().lists.active.items).toEqual([]);
        expect(cursors).toEqual([null, 'later-page']);
    });

    it('keeps active and archived keyset pages separate and merges repeated rows stably', async () => {
        const first = summary('discussion-a', null, 3);
        const second = summary('discussion-b', null, 2);
        const activeOutcomes: Awaited<ReturnType<DiscussionRepositoryClient['list']>>[] = [
            { kind: 'succeeded', value: listResult([first], 'next-active') },
            { kind: 'succeeded', value: listResult([first, second], null) },
        ];
        const list = vi.fn<DiscussionRepositoryClient['list']>(async (input) => (
            input?.state === 'archived'
                ? { kind: 'succeeded', value: listResult([{ ...first, archivedAt: 20 }], null) }
                : activeOutcomes.shift()!
        ));
        const repository = createDiscussionRepository({ scope, address, client: client({ list }) });

        await repository.refreshList('active');
        const firstReference = repository.getSnapshot().lists.active.items[0];
        await repository.loadMoreList('active');
        expect(repository.getSnapshot().lists.active.items.map(item => item.id)).toEqual(['discussion-a', 'discussion-b']);
        expect(repository.getSnapshot().lists.active.items[0]).toBe(firstReference);
        await repository.refreshList('archived');

        const snapshot = repository.getSnapshot();
        expect(snapshot.lists.active.items.map((item) => item.id)).toEqual(['discussion-b']);
        expect(snapshot.lists.archived.items.map((item) => item.id)).toEqual(['discussion-a']);
        // The active refresh's archived-existence probe is one bounded read, not a page.
        expect(list.mock.calls.map(([input]) => input)).toEqual([
            { state: 'active' },
            { state: 'archived', limit: 1 },
            { state: 'active', cursor: 'next-active' },
            { state: 'archived' },
        ]);
    });

    it('prepends older message pages without disturbing existing row identities', async () => {
        const recent = [message(3), message(4)];
        const older = [message(1), message(2)];
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValueOnce({ kind: 'succeeded', value: readResult(recent, true, 4) })
            .mockResolvedValueOnce({ kind: 'succeeded', value: readResult(older, false, 4) });
        const repository = createDiscussionRepository({ scope, address, client: client({ read }) });

        await repository.refreshMessages('discussion-a');
        const recentReference = repository.getSnapshot().threads['discussion-a']!.messages[0];
        await repository.loadOlderMessages('discussion-a');

        const thread = repository.getSnapshot().threads['discussion-a']!;
        expect(thread.messages.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
        expect(thread.messages[2]).toBe(recentReference);
        expect(read.mock.calls[1]?.[1]).toEqual({ beforeSeq: 3 });
    });

    it('retains one create identity through outcome-unknown reconciliation and explicit retry', async () => {
        const canonicalSummary = summary('discussion-created', 'create-local-a', 1);
        const created: DiscussionCreateResultV1 = {
            v: 1,
            serverId: address.serverId,
            
            discussion: canonicalSummary,
            firstMessage: { ...message(1, 'message-local-a'), discussionId: 'discussion-created' },
        };
        const create = vi.fn<DiscussionRepositoryClient['create']>()
            .mockResolvedValueOnce({ kind: 'failed', errorCode: 'outcome_unknown' })
            .mockResolvedValueOnce({ kind: 'succeeded', value: created });
        const repository = createDiscussionRepository({ scope, address, client: client({ create }) });
        const input = { creationLocalId: 'create-local-a', messageLocalId: 'message-local-a', title: 'Release', content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Ready?' }] }, draftSubmission: draftSubmission() };

        const unknown = await repository.create(input);
        expect(unknown.kind).toBe('checking');
        expect(repository.getSnapshot().mutations['create-local-a']).toMatchObject({ status: 'checking', messageLocalId: 'message-local-a' });
        await vi.waitFor(() => expect(repository.getSnapshot().mutations['create-local-a']).toMatchObject({
            status: 'outcome_unknown',
            errorCode: 'outcome_unknown',
        }));

        const retried = await repository.retry('create-local-a');
        expect(retried.kind).toBe('succeeded');
        const submitted = create.mock.calls.map(([{ onResolvedParticipants: _observe, ...intent }]) => intent);
        expect(submitted).toHaveLength(2);
        expect(submitted[0]).toEqual(submitted[1]);
        expect(repository.getSnapshot().lists.active.items[0]?.id).toBe('discussion-created');
    });

    it('keeps activity order stable when a title-only rename updates an existing summary', async () => {
        const newest = summary('discussion-newest', null, 3);
        const renamed = {
            ...summary('discussion-older', null, 2),
            title: 'Renamed without new activity',
        };
        const list = vi.fn<DiscussionRepositoryClient['list']>()
            .mockResolvedValue({ kind: 'succeeded', value: listResult([
                newest,
                { ...renamed, title: 'Original title' },
            ], null) });
        const rename = vi.fn<DiscussionRepositoryClient['rename']>()
            .mockResolvedValue({
                kind: 'succeeded',
                value: {
                    v: 1,
                    serverId: address.serverId,
                    
                    discussion: renamed,
                },
            });
        const repository = createDiscussionRepository({ scope, address, client: client({ list, rename }) });
        await repository.refreshList('active');

        await repository.rename('discussion-older', 'Renamed without new activity');

        expect(repository.getSnapshot().lists.active.items.map((item) => item.id)).toEqual([
            'discussion-newest',
            'discussion-older',
        ]);
        expect(repository.getSnapshot().lists.active.items[1]?.title).toBe('Renamed without new activity');
    });

    it('reconciles an outcome-unknown create from canonical list/read state without resending', async () => {
        const canonicalSummary = summary('discussion-created', 'create-local-a', 1);
        const create = vi.fn<DiscussionRepositoryClient['create']>()
            .mockResolvedValue({ kind: 'failed', errorCode: 'outcome_unknown' });
        const list = vi.fn<DiscussionRepositoryClient['list']>()
            .mockResolvedValue({ kind: 'succeeded', value: listResult([canonicalSummary], null) });
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValue({
                kind: 'succeeded',
                value: {
                    ...readResult([{ ...message(1, 'message-local-a'), discussionId: 'discussion-created' }], false, 1),
                    discussionId: 'discussion-created',
                },
            });
        const repository = createDiscussionRepository({ scope, address, client: client({ create, list, read }) });

        const outcome = await repository.create({
            creationLocalId: 'create-local-a',
            messageLocalId: 'message-local-a',
            title: 'Release',
            content: { v: 1, parts: [{ t: 'text', text: 'Ready?' }] },
            draftSubmission: draftSubmission(),
        });
        expect(outcome.kind).toBe('checking');
        await vi.waitFor(() => expect(repository.getSnapshot().mutations['create-local-a']?.status).toBe('observed_success'));

        expect(create).toHaveBeenCalledTimes(1);
        expect(repository.getSnapshot().threads['discussion-created']?.messages[0]?.localId).toBe('message-local-a');
        repository.acknowledgeObservedSuccess('create-local-a');
        expect(repository.getSnapshot().mutations['create-local-a']).toBeUndefined();
    });

    it('reconciles an outcome-unknown create whose committed discussion is already archived', async () => {
        const archivedSummary = { ...summary('discussion-created', 'create-local-a', 1), archivedAt: 5 };
        const create = vi.fn<DiscussionRepositoryClient['create']>()
            .mockResolvedValue({ kind: 'failed', errorCode: 'outcome_unknown' });
        const list = vi.fn<DiscussionRepositoryClient['list']>()
            .mockImplementation(async (input) => {
                if (!input) throw new Error('expected a scoped discussion list request');
                return {
                    kind: 'succeeded',
                    value: listResult(input.state === 'archived' ? [archivedSummary] : [], null),
                };
            });
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValue({
                kind: 'succeeded',
                value: {
                    ...readResult([{ ...message(1, 'message-local-a'), discussionId: 'discussion-created' }], false, 1),
                    discussionId: 'discussion-created',
                },
            });
        const repository = createDiscussionRepository({ scope, address, client: client({ create, list, read }) });

        const outcome = await repository.create({
            creationLocalId: 'create-local-a',
            messageLocalId: 'message-local-a',
            title: 'Release',
            content: { v: 1, parts: [{ t: 'text', text: 'Ready?' }] },
            draftSubmission: draftSubmission(),
        });
        expect(outcome.kind).toBe('checking');
        await vi.waitFor(() => expect(repository.getSnapshot().mutations['create-local-a']?.status).toBe('observed_success'));

        expect(create).toHaveBeenCalledTimes(1);
        expect(repository.getSnapshot().lists.archived.items.map((item) => item.id)).toEqual(['discussion-created']);
        expect(repository.getSnapshot().lists.active.items).toEqual([]);
        expect(repository.getSnapshot().threads['discussion-created']?.messages[0]?.localId).toBe('message-local-a');
    });

    it('recognizes an outcome-unknown post already published by a racing refresh', async () => {
        const published = { ...message(2, 'post-local-a'), discussionId: 'discussion-a' };
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValueOnce({ kind: 'succeeded', value: readResult([published], false, 2) })
            .mockResolvedValue({ kind: 'succeeded', value: readResult([], false, 2) });
        const post = vi.fn<DiscussionRepositoryClient['post']>()
            .mockResolvedValue({ kind: 'failed', errorCode: 'outcome_unknown' });
        const repository = createDiscussionRepository({ scope, address, client: client({ read, post }) });
        await repository.refreshMessages('discussion-a');

        const outcome = await repository.post({
            discussionId: 'discussion-a',
            localId: 'post-local-a',
            content: { v: 1, parts: [{ t: 'text', text: 'Already visible' }] },
            draftSubmission: draftSubmission(),
        });

        expect(outcome.kind).toBe('checking');
        await vi.waitFor(() => expect(repository.getSnapshot().mutations['post-local-a']).toMatchObject({
            status: 'observed_success',
        }));
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('adopts a reload-restored post by exact local identity without draining unrelated history or resending', async () => {
        const published = { ...storedMessage('discussion-a', 425), localId: 'post-local-restored' };
        const rows = Array.from({ length: 1000 }, (_, index) => index + 1 === published.seq ? published : storedMessage('discussion-a', index + 1));
        const foreign = { ...storedMessage('discussion-a', 1000), localId: published.localId, authorAccountId: 'account-b',
            accountActor: { v: 1 as const, accountId: 'account-b', profile: null } };
        rows[rows.length - 1] = foreign;
        const requests: URL[] = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            if (!url.pathname.endsWith('/messages')) return response({ discussion: { ...storedSummary('discussion-a'), messageSeq: rows.length } });
            requests.push(url);
            return response({ messages: url.searchParams.get('localId') === published.localId ? [published] : rows.slice(-20),
                hasMoreOlder: false, messageSeq: rows.length });
        }) });
        await repository.refreshMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']?.messages.find(row => row.id === foreign.id)?.authorAccountId).toBe('account-b');
        requests.length = 0;

        repository.adoptPendingIntent({
            kind: 'post',
            discussionId: 'discussion-a',
            localId: 'post-local-restored',
            content: { v: 1, parts: [{ t: 'text', text: 'Restored' }] },
            draftSubmission: draftSubmission('discussion'),
        });

        await vi.waitFor(() => expect(repository.getSnapshot().mutations['post-local-restored']?.status).toBe('observed_success'));
        expect(requests.map(url => url.pathname + url.search)).toEqual(['/v1/discussions/discussion-a/messages?localId=post-local-restored']);
        expect(repository.getSnapshot().threads['discussion-a']?.messages.find(row => row.id === published.id)?.authorAccountId).toBe(scope.accountId);
        expect(repository.getSnapshot().threads['discussion-a']?.messages.find(row => row.id === foreign.id)?.authorAccountId).toBe('account-b');
    });

    it('separates a dismissable definitive refusal from a retryable transient failure', async () => {
        const post = vi.fn<DiscussionRepositoryClient['post']>()
            .mockResolvedValueOnce({ kind: 'failed', errorCode: 'discussion_invalid_mention' })
            .mockResolvedValueOnce({ kind: 'failed', errorCode: 'offline' });
        const repository = createDiscussionRepository({ scope, address, client: client({ post }) });
        const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Keep me' }] };

        await repository.post({ discussionId: 'discussion-a', localId: 'post-definitive', content, draftSubmission: draftSubmission('discussion') });
        await repository.post({ discussionId: 'discussion-a', localId: 'post-transient', content, draftSubmission: draftSubmission('discussion') });

        expect(repository.getSnapshot().mutations['post-definitive']).toMatchObject({
            status: 'failed', errorCode: 'discussion_invalid_mention', recovery: 'dismiss',
        });
        expect(repository.getSnapshot().mutations['post-transient']).toMatchObject({
            status: 'failed', errorCode: 'offline', recovery: 'retry',
        });

        expect(repository.dismissFailure('post-definitive')).toBe(true);
        expect(repository.getSnapshot().mutations['post-definitive']).toBeUndefined();
        await expect(repository.retry('post-definitive')).resolves.toEqual({
            kind: 'failed', errorCode: 'discussion_retry_not_found',
        });
        // Only a settled failure can be dismissed; in-flight and unknown outcomes keep their identity.
        expect(repository.dismissFailure('post-missing')).toBe(false);
        expect(repository.getSnapshot().mutations['post-transient']?.status).toBe('failed');
    });

    it('keeps an approval-pending post visible without claiming success', async () => {
        const post = vi.fn<DiscussionRepositoryClient['post']>().mockResolvedValue({
            kind: 'approval_request_created', artifactId: 'approval-a', actionId: 'discussion.post',
        });
        const repository = createDiscussionRepository({ scope, address, client: client({ post }) });

        const outcome = await repository.post({ discussionId: 'discussion-a', localId: 'post-local-a', content: { v: 1, parts: [{ t: 'text', text: 'Needs approval' }] }, draftSubmission: draftSubmission('discussion') });

        expect(outcome).toEqual({ kind: 'approval_request_created', artifactId: 'approval-a' });
        expect(repository.getSnapshot().mutations['post-local-a']).toMatchObject({ status: 'approval_pending', artifactId: 'approval-a' });
    });

    it('retains remount-adoptable draft currentness until later canonical success is acknowledged', async () => {
        const submission = draftSubmission('discussion');
        const canonical = message(2, 'post-local-remount');
        const post = vi.fn<DiscussionRepositoryClient['post']>().mockResolvedValue({
            kind: 'approval_request_created', artifactId: 'approval-remount', actionId: 'discussion.post',
        });
        const read = vi.fn<DiscussionRepositoryClient['read']>().mockResolvedValue({
            kind: 'succeeded', value: readResult([canonical], false, 2),
        });
        const repository = createDiscussionRepository({ scope, address, client: client({ post, read }) });

        await repository.post({
            discussionId: 'discussion-a',
            localId: 'post-local-remount',
            content: { v: 1, parts: [{ t: 'text', text: 'Survive remount' }] },
            draftSubmission: submission,
        });
        const adopted = repository.getSnapshot().mutations['post-local-remount'];
        expect(adopted).toMatchObject({ status: 'approval_pending', draftSubmission: submission });

        await repository.refreshMessages('discussion-a');
        await vi.waitFor(() => expect(repository.getSnapshot().mutations['post-local-remount']?.status).toBe('observed_success'));
        expect(repository.getSnapshot().mutations['post-local-remount']?.draftSubmission).toBe(submission);
        repository.acknowledgeObservedSuccess('post-local-remount');
        expect(repository.getSnapshot().mutations['post-local-remount']).toBeUndefined();
        expect(post).toHaveBeenCalledOnce();
    });

    it('shares one qualified repository and one mounted watcher lifetime across list and detail consumers', () => {
        clearDiscussionRepositoryRegistryForTests();
        const scope = { serverId: address.serverId, accountId: 'account-a' } as const;
        const repositoryClient = client();
        const first = getDiscussionRepository({ scope, address, client: repositoryClient });
        const second = getDiscussionRepository({ scope, address, client: repositoryClient });

        expect(second).toBe(first);
        const unmountList = first.mount();
        const unmountDetails = second.mount();
        unmountList();
        expect(first.isMounted()).toBe(true);
        unmountDetails();
        expect(first.isMounted()).toBe(false);
        clearDiscussionRepositoryRegistryForTests();
    });

    it('refreshes the shared repository client when its exact-Home runtime is reconstructed', async () => {
        clearDiscussionRepositoryRegistryForTests();
        const scope = { serverId: address.serverId, accountId: 'account-a' } as const;
        const staleList = vi.fn<DiscussionRepositoryClient['list']>();
        const currentList = vi.fn<DiscussionRepositoryClient['list']>()
            .mockResolvedValue({ kind: 'succeeded', value: listResult([summary('discussion-current', null, 1)], null) });
        const first = getDiscussionRepository({ scope, address, client: client({ list: staleList }) });
        const second = getDiscussionRepository({ scope, address, client: client({ list: currentList }) });

        await second.refreshList('active');

        expect(second).toBe(first);
        expect(staleList).not.toHaveBeenCalled();
        expect(currentList).toHaveBeenCalledWith({ state: 'active' }, undefined);
        expect(second.getSnapshot().lists.active.items[0]?.id).toBe('discussion-current');
        clearDiscussionRepositoryRegistryForTests();
    });

    it('refreshes mounted canonical state for an exact Discussion change without blanking the retained page', async () => {
        const first = summary('discussion-a', null, 1);
        const refreshed = { ...first, messageSeq: 2, unreadCount: 2 };
        const pending = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['get']>>>();
        const list = vi.fn<DiscussionRepositoryClient['list']>((input) => (
            Promise.resolve({ kind: 'succeeded' as const, value: listResult(input?.state === 'archived' ? [] : [first], null) })
        ));
        const get = vi.fn<DiscussionRepositoryClient['get']>().mockReturnValue(pending.promise);
        const repository = createDiscussionRepository({ scope, address, client: client({ list, get }) });
        await repository.refreshList('active');
        const unmount = repository.mount();

        publishMountedDiscussionChanges({
            serverId: address.serverId, accountId: scope.accountId,
            changes: [{ cursor: 1, kind: 'discussion', entityId: 'discussion-a', changedAt: 1, hint: { unrelatedSessionProjection: true } }],
        });

        expect(repository.getSnapshot().lists.active).toMatchObject({
            items: [first],
            status: 'ready',
        });
        pending.resolve({ kind: 'succeeded', value: { v: 1, serverId: scope.serverId, discussion: refreshed } });
        await vi.waitFor(() => expect(repository.getSnapshot().lists.active.items[0]?.messageSeq).toBe(2));
        expect(get).toHaveBeenCalledExactlyOnceWith('discussion-a', undefined);
        expect(list.mock.calls.filter(([input]) => input?.state === 'active')).toHaveLength(1);
        unmount();
    });

    it('classifies read-cursor transport failures for state-change retry without treating them as success', async () => {
        const readState = vi.fn<DiscussionRepositoryClient['readState']>()
            .mockResolvedValue({ kind: 'failed', errorCode: 'outcome_unknown' });
        const repository = createDiscussionRepository({ scope, address, client: client({ readState }) });

        await expect(repository.setReadState('discussion-a', 4)).resolves.toEqual({
            kind: 'retryable',
            errorCode: 'outcome_unknown',
        });
    });

    it('stops visible-read retries after canonical untracking without purging readable discussion content', async () => {
        const readState = vi.fn<DiscussionRepositoryClient['readState']>()
            .mockResolvedValue({ kind: 'failed', errorCode: 'discussion_not_tracked' });
        const repository = createDiscussionRepository({ scope, address, client: client({ readState }) });

        await expect(repository.setReadState('discussion-a', 4)).resolves.toEqual({
            kind: 'stopped',
            errorCode: 'discussion_not_tracked',
        });
        expect(repository.getSnapshot().lists.active.status).toBe('idle');
    });

    it('merges an overlapping tail read into current thread state instead of its pre-await snapshot', async () => {
        const pendingReads: Array<(value: Awaited<ReturnType<DiscussionRepositoryClient['read']>>) => void> = [];
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValueOnce({ kind: 'succeeded', value: readResult([message(1)], false, 1) })
            .mockImplementation(() => new Promise((resolve) => { pendingReads.push(resolve); }));
        const repository = createDiscussionRepository({ scope, address, client: client({ read }) });
        await repository.refreshMessages('discussion-a');

        const slower = repository.refreshMessages('discussion-a');
        const faster = repository.refreshMessages('discussion-a');
        pendingReads[1]!({ kind: 'succeeded', value: readResult([message(2), message(3)], false, 3) });
        await faster;
        expect(repository.getSnapshot().threads['discussion-a']!.messages.map((row) => row.seq)).toEqual([1, 2, 3]);
        pendingReads[0]!({ kind: 'succeeded', value: readResult([message(2)], false, 2) });
        await slower;

        // Two mounted surfaces refresh the same thread independently; the response
        // that settles second must not delete the messages the other one published.
        const thread = repository.getSnapshot().threads['discussion-a']!;
        expect(thread.messages.map((row) => row.seq)).toEqual([1, 2, 3]);
        expect(thread.messageSeq).toBe(3);
    });

    it('keeps the messages a concurrent read published when an overlapping read fails', async () => {
        const pendingReads: Array<(value: Awaited<ReturnType<DiscussionRepositoryClient['read']>>) => void> = [];
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValueOnce({ kind: 'succeeded', value: readResult([message(1)], false, 1) })
            .mockImplementation(() => new Promise((resolve) => { pendingReads.push(resolve); }));
        const repository = createDiscussionRepository({ scope, address, client: client({ read }) });
        await repository.refreshMessages('discussion-a');

        const failing = repository.refreshMessages('discussion-a');
        const succeeding = repository.refreshMessages('discussion-a');
        pendingReads[1]!({ kind: 'succeeded', value: readResult([message(2), message(3)], false, 3) });
        await succeeding;
        pendingReads[0]!({ kind: 'failed', errorCode: 'offline' });
        await failing;

        // A retryable failure reports the failure; it must not republish the thread
        // as it looked before the successful concurrent read landed.
        const thread = repository.getSnapshot().threads['discussion-a']!;
        expect(thread.messages.map((row) => row.seq)).toEqual([1, 2, 3]);
        expect(thread.messageSeq).toBe(3);
        expect(thread).toMatchObject({ status: 'offline', errorCode: 'offline' });
    });

    it('completes an older Discussion page against the message that arrived while it was in flight', async () => {
        let resolveOlder: (value: Awaited<ReturnType<DiscussionRepositoryClient['read']>>) => void = () => {
            throw new Error('older read resolver was not installed');
        };
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValueOnce({ kind: 'succeeded', value: readResult([message(3)], true, 3) })
            .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }));
        const post = vi.fn<DiscussionRepositoryClient['post']>().mockResolvedValue({
            kind: 'succeeded',
            value: {
                v: 1,
                serverId: address.serverId,
                
                message: message(4, 'post-local-older'),
                messageSeq: 4,
            },
        });
        const repository = createDiscussionRepository({ scope, address, client: client({ read, post }) });
        await repository.refreshMessages('discussion-a');

        const older = repository.loadOlderMessages('discussion-a');
        await repository.post({
            discussionId: 'discussion-a',
            localId: 'post-local-older',
            content: { v: 1, parts: [{ t: 'text', text: 'message 4' }] },
            draftSubmission: draftSubmission('discussion'),
        });
        resolveOlder({ kind: 'succeeded', value: readResult([message(1), message(2)], false, 3) });
        await older;

        const thread = repository.getSnapshot().threads['discussion-a']!;
        expect(thread.messages.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
        expect(thread.messageSeq).toBe(4);
        expect(thread.hasMoreOlder).toBe(false);
    });

    it('keeps the fetched summary when an existing Discussion is first opened in a new repository lifetime', async () => {
        // Cold start: the list is loaded, the reader opens an existing Discussion,
        // and its get and read both succeed. Nothing may leave the thread without
        // the summary the get just returned.
        const existing = summary('discussion-a', null, 1);
        const repository = createDiscussionRepository({ scope, address, client: client({
            list: vi.fn<DiscussionRepositoryClient['list']>().mockResolvedValue({ kind: 'succeeded', value: listResult([existing], null) }),
            get: vi.fn<DiscussionRepositoryClient['get']>().mockResolvedValue({
                kind: 'succeeded',
                value: { v: 1, serverId: address.serverId, discussion: existing },
            }),
            read: vi.fn<DiscussionRepositoryClient['read']>().mockResolvedValue({ kind: 'succeeded', value: readResult([message(1)], false, 1) }),
        }) });

        await repository.refreshList('active');
        await repository.refreshDiscussion('discussion-a');

        const thread = repository.getSnapshot().threads['discussion-a']!;
        expect(thread.summary).toEqual(existing);
        expect(thread.messages.map((row) => row.seq)).toEqual([1]);
        expect(thread.status).toBe('ready');
    });

    it('reopens retained locked rows through the current cipher once the Session key arrives', async () => {
        const lockedRow = { ...message(1), content: null };
        const readOpened = { current: false };
        const read = vi.fn<DiscussionRepositoryClient['read']>(async (_discussionId, input) => (
            input?.afterSeq === undefined || input.afterSeq === 0
                ? { kind: 'succeeded' as const, value: { ...readResult(readOpened.current ? [message(1)] : [lockedRow], false, 1), incomplete: !readOpened.current } }
                : { kind: 'succeeded' as const, value: readResult([], false, 1) }
        ));
        const repository = createDiscussionRepository({ scope, address, client: client({ read }) });

        await repository.refreshMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']).toMatchObject({ status: 'locked', incomplete: true });
        expect(repository.getSnapshot().threads['discussion-a']!.messages[0]!.content).toBeNull();

        readOpened.current = true;
        await repository.refreshMessages('discussion-a');

        // The adapter discarded the ciphertext, so the retained null row can only be
        // completed by asking the Discussion owner for it again under the new key.
        const thread = repository.getSnapshot().threads['discussion-a']!;
        expect(thread.messages.map((row) => row.content)).toEqual([message(1).content]);
        expect(thread).toMatchObject({ status: 'ready', incomplete: false });
    });

    /**
     * Whether an archived Discussion exists at all is a fact this owner already
     * has a route for. Answering it with one bounded probe beside the active
     * refresh keeps the archived disclosure truthful without preloading a page
     * the reader did not ask for, and without a new wire bit.
     */
    it('answers archived existence from one bounded probe beside the active refresh', async () => {
        const archivedRows = { current: [summary('discussion-archived', null, 1)] };
        const list = vi.fn<DiscussionRepositoryClient['list']>(async (input) => (
            input?.state === 'archived'
                ? { kind: 'succeeded' as const, value: listResult(archivedRows.current, 'archived-page-2') }
                : { kind: 'succeeded' as const, value: listResult([], null) }
        ));
        const repository = createDiscussionRepository({ scope, address, client: client({ list }) });

        expect(repository.getSnapshot().archivedExistence).toBe('unknown');
        await repository.refreshList('active');

        // One bounded probe, not a page: the archived list itself stays idle and
        // is still loaded lazily when the reader opens the disclosure.
        expect(list).toHaveBeenCalledWith({ state: 'archived', limit: 1 }, undefined);
        expect(repository.getSnapshot().archivedExistence).toBe('present');
        expect(repository.getSnapshot().lists.archived).toMatchObject({ status: 'idle', items: [] });

        archivedRows.current = [];
        await repository.refreshList('active');
        expect(repository.getSnapshot().archivedExistence).toBe('empty');
    });

    it('never claims archived emptiness from a refused probe', async () => {
        const list = vi.fn<DiscussionRepositoryClient['list']>(async (input) => (
            input?.state === 'archived'
                ? { kind: 'failed' as const, errorCode: 'offline' }
                : { kind: 'succeeded' as const, value: listResult([], null) }
        ));
        const repository = createDiscussionRepository({ scope, address, client: client({ list }) });

        await repository.refreshList('active');

        // An unanswered probe is not an answer: the disclosure keeps offering the
        // archived list rather than telling the reader there is nothing there.
        expect(repository.getSnapshot().archivedExistence).toBe('unknown');
        expect(repository.getSnapshot().lists.active.status).toBe('ready');
    });
});
