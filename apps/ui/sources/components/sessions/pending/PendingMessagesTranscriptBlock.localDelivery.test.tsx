import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { PendingRequestedActionV1Schema, PendingResetStartSetResultV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';

import { createDeferred, createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { Modal } from '@/modal';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { Encryption } from '@/sync/encryption/encryption';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import '@/sync/syncEngine';
import { sync, type SyncMessageTransport } from '@/sync/sync';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { buildChatListItems } from '@/components/sessions/chatListItems';
import { PendingMessagesTranscriptBlock } from './PendingMessagesTranscriptBlock';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { EntityFlatReorderList } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { resolvePendingReorderIds } from '@/sync/domains/pending/pendingReorder';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { resolvePendingMessagesPresentation } from './pendingMessageVisualState';
import { TranscriptRowLayoutMutationProvider } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import { estimateTranscriptRowHeightFromContent } from '@/components/sessions/transcript/measurement/estimateTranscriptRowHeightFromCache';
import { PENDING_QUEUE_TOP_INSET_PX } from './pendingQueueContentClipping';

// Native presentation and confirmation are the only replaced UI boundaries.
// The real store, transcript projection, action handlers and Sync submit owner run below them.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});

const initialStorage = storage.getState();
const sessionId = 'local-direct-action';
let actionRequests: string[] = [];
let durableLocalIds = new Set<string>();

beforeEach(async () => {
    resetServerFeaturesClientForTests();
    vi.stubGlobal('indexedDB', new IDBFactory());
    const activeTarget = getActiveServerSnapshot();
    const scope = { serverId: activeTarget.serverId, accountId: 'local-direct-account' };
    const token = `e30.${Buffer.from(JSON.stringify({ sub: scope.accountId })).toString('base64url')}.signature`;
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token, secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64url') });
    storage.getState().activateProfileScope(scope);
    storage.getState().applySessions([createSessionFixture({
        id: sessionId,
        encryptionMode: 'plain',
        active: true,
        activeAt: Date.now(),
        metadata: { ...createSessionFixture().metadata!, version: '0.0.9' },
    })]);
    // Bind the direct Sync fixture to the transport/Account it serves; no connection restore is run.
    sync.encryption = await Encryption.create(new Uint8Array(32).fill(7));
    Reflect.set(sync, 'appliedServerTarget', activeTarget);
    Reflect.set(sync, 'serverID', scope.accountId);
    actionRequests = [];
    durableLocalIds = new Set();
    const features = createRootLayoutFeaturesResponse({ capabilities: {
        session: { ...createRootLayoutFeaturesResponse().capabilities.session, pendingInput: { protocolVersion: 3 } },
    } });
    const respond = (path: string, init?: RequestInit): Response => {
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (init?.method === 'PATCH' && path.endsWith('/action')) {
            actionRequests.push(path);
            const localId = path.split('/').at(-2)!;
            const body: unknown = JSON.parse(String(init.body));
            if (!body || typeof body !== 'object') throw new Error('Pending action fixture expected a request body');
            const requestedAction = PendingRequestedActionV1Schema.parse(Reflect.get(body, 'requestedAction'));
            return durableLocalIds.has(localId)
                ? Response.json(PendingResetStartSetResultV1Schema.parse({ didUpdate: true, requestedAction }))
                : Response.json({ error: 'not-found' }, { status: 404 });
        }
        return path === '/v1/features'
            ? Response.json(features)
            : Response.json({ ok: true });
    };
    setRuntimeFetch(async (input, init) => respond(new URL(String(input)).pathname, init));
    vi.spyOn(apiSocket, 'request').mockImplementation(async (path, init) => respond(path, init));
});

afterEach(() => {
    standardCleanup();
    sync.disconnectServer();
    storage.setState(initialStorage, true);
    resetServerFeaturesClientForTests();
    resetRuntimeFetch();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('pending transcript local delivery custody', () => {
    it('makes counted Follow notices read-only through the real body reorder binding and presenter', async () => {
        const message = (id: string, sourceSessionId: string): PendingMessage => ({
            id, localId: id, createdAt: 1, updatedAt: 1, source: 'server_pending', pendingDeliveryStatus: 'server_queued',
            text: 'provider prompt', rawRecord: null,
            pendingHostFollowInput: SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn',
                original: { sourceSessionId, sourceTurn: { id, status: 'completed' } }, event: { kind: 'finished' } }),
        });
        const messages = [message('A1', 'source-a'), message('A2', 'source-a'), message('B1', 'source-b')];
        const serverId = getActiveServerSnapshot().serverId;
        const mutations = vi.fn();
        const render = (rows: readonly PendingMessage[]) => <TranscriptRowLayoutMutationProvider value={mutations}>
            <AppSessionTranscriptSourceProvider sessionId={sessionId} serverId={serverId}>
                <PendingMessagesTranscriptBlock sessionId={sessionId} serverId={serverId} pendingMessages={rows} discardedMessages={[]} />
            </AppSessionTranscriptSourceProvider>
        </TranscriptRowLayoutMutationProvider>;
        const screen = await renderScreen(render(messages));
        const binding = screen.findByType(EntityFlatReorderList).props.binding as React.ComponentProps<typeof EntityFlatReorderList>['binding'];
        expect(binding.scope).not.toBeNull();
        const input = { scope: binding.scope!, sessionId, recipient: null, sourceId: 'A1', position: { anchorId: 'B1', placement: 'after' as const } };
        // The durable queue owner permits the individual move; presentation must never issue it for an aggregate.
        expect(resolvePendingReorderIds(messages, input)).toEqual(['A2', 'B1', 'A1']);
        expect(binding.getItem('A1')).toBeNull();
        expect(binding.getItem('A2')).toBeNull();
        expect(binding.resolve('A1', input.position).status).toBe('refused');
        expect(screen.findHostByTestId('pendingMessages.reorder:A1')).toBeNull();
        expect(screen.findHostByTestId('pendingMessages.remove:A1')).toBeNull();
        expect(screen.findHostByTestId('pendingMessages.edit:A1')).toBeNull();
        expect(screen.findHostByTestId('pendingMessages.row:A2')).toBeNull();
        const materializing = resolvePendingMessagesPresentation(messages, { materializingLocalIds: new Set(['A1']) });
        expect(materializing.shownRows.map(row => row.message.id)).toEqual(['A1', 'A2', 'B1']);
        expect(materializing.rows.every(row => !row.aggregate)).toBe(true);
        expect(binding.getItem('B1')).toMatchObject({ localId: 'B1' });
        expect(binding.resolve('B1', { anchorId: 'A1', placement: 'before' }).status).toBe('refused');
        expect(binding.resolve('B1', { anchorId: null, placement: 'after' }).status).toBe('refused');
        // Timestamp-only arrivals do not invalidate the mounted row's height reservation.
        for (let tick = 2; tick <= 11; tick++) await screen.update(render(messages.map(row => ({ ...row, updatedAt: tick }))));
        expect(mutations).toHaveBeenCalledTimes(0);
        // Once actually shown individually, both A rows retain the existing individual reorder path.
        const individual = [messages[0]!, { ...messages[1]!, pendingHostFollowInput: undefined }, messages[2]!];
        await screen.update(render(individual));
        expect(mutations).toHaveBeenCalledTimes(1);
        expect(mutations).toHaveBeenLastCalledWith({ reason: 'content-change', sourceId: 'pending-queue' });
        const individualBinding = screen.findByType(EntityFlatReorderList).props.binding as typeof binding;
        expect(individualBinding.getItem('A1')).toMatchObject({ localId: 'A1' });
        expect(individualBinding.resolve('A1', input.position).status).toBe('allowed');
        expect(screen.findHostByTestId('pendingMessages.reorder:A1')).not.toBeNull();
        expect(messages.map(message => message.id)).toEqual(['A1', 'A2', 'B1']);
        const folded = Array.from({ length: 6 }, (_, index) => message(`A${index}`, 'source-a'));
        await screen.update(render(folded));
        const estimated = estimateTranscriptRowHeightFromContent({ platformIsWeb: true, toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => null, item: { kind: 'pending-queue', id: 'pending-queue', pendingMessages: folded, discardedMessages: [] } });
        expect(screen.findHostByTestId('pendingMessages.scroll')?.props.style.height).toBe(estimated! - PENDING_QUEUE_TOP_INSET_PX);
    });
    it('does not mutate a server queue row while its local direct send is still awaiting acknowledgement', async () => {
        const localId = 'local-direct-action-message';
        const ack = createDeferred<unknown>();
        const emitWithAck = vi.fn();
        sync.setMessageTransport({
            async emitWithAck<T>(...args: Parameters<SyncMessageTransport['emitWithAck']>) {
                emitWithAck(...args);
                // The generic transport boundary returns the ACK supplied by this fixture.
                return await ack.promise as T;
            },
            send: vi.fn(),
        });

        const sending = sync.sendMessage(sessionId, 'still sending', undefined, undefined, { localId });
        try {
            await vi.waitFor(() => expect(emitWithAck).toHaveBeenCalledTimes(1));
            const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
            expect(pending).toMatchObject([{ localId, source: 'local_outbound' }]);
            expect(pending[0]?.pendingOutboxOperation).toBeUndefined();
            const queue = buildChatListItems({
                messageIdsOldestFirst: [], messagesById: {}, pendingMessages: pending,
            }).find((item) => item.kind === 'pending-queue');
            expect(queue?.kind).toBe('pending-queue');
            if (queue?.kind !== 'pending-queue') throw new Error('Local delivery must remain visible in the transcript');
            const screen = await renderScreen(<PendingMessagesTranscriptBlock
                sessionId={sessionId}
                pendingMessages={queue.pendingMessages}
                discardedMessages={queue.discardedMessages}
            />);
            const sendNow = screen.findHostByTestId(`pendingMessages.sendNow:${localId}`);
            if (sendNow && sendNow.props.disabled !== true) {
                await screen.pressByTestIdAsync(`pendingMessages.sendNow:${localId}`);
                await vi.waitFor(() => expect(actionRequests.length > 0 || vi.mocked(Modal.alert).mock.calls.length > 0).toBe(true));
            }
            expect(actionRequests).toEqual([]);
            expect(sendNow).toBeNull();
            expect(screen.findHostByTestId(`pendingMessages.steerNow:${localId}`)).toBeNull();
            expect(screen.findHostByTestId(`pendingMessages.message:${localId}`)).not.toBeNull();
            expect(screen.findHostByTestId(`pendingMessages.copy:${localId}`)).not.toBeNull();
            expect(Modal.alert).not.toHaveBeenCalled();
            expect(storage.getState().sessionPending[sessionId]?.messages[0]?.localId).toBe(localId);
        } finally {
            await act(async () => {
                ack.resolve({ ok: true, id: 'committed-local-direct', seq: 1, localId, didWrite: true });
                await sending;
            });
        }
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it.each([undefined, { kind: 'execution_run' as const, runId: 'run-1' }])(
        'keeps Send Now available for the exact server-owned recipient %j and retains its payload', async (recipient) => {
        const localId = 'durable-action-message';
        const rawRecord = { role: 'user', content: { type: 'text', text: 'queued on server' }, meta: {} } as const;
        durableLocalIds.add(localId);
        const actionPath = recipient
            ? `/v2/sessions/${sessionId}/execution-runs/${recipient.runId}/pending/${localId}/action`
            : `/v2/sessions/${sessionId}/pending/${localId}/action`;
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', pendingDeliveryStatus: 'server_queued', recipient,
            text: 'queued on server', rawRecord,
        });
        const screen = await renderScreen(<PendingMessagesTranscriptBlock
            sessionId={sessionId}
            recipient={recipient}
            pendingMessages={storage.getState().sessionPending[sessionId]!.messages}
            discardedMessages={[]}
        />);
        const sendNow = screen.findHostByTestId(`pendingMessages.sendNow:${localId}`);
        expect(sendNow).not.toBeNull();
        expect(sendNow?.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync(`pendingMessages.sendNow:${localId}`);
        await vi.waitFor(() => expect({ actions: actionRequests, errors: vi.mocked(Modal.alert).mock.calls }).toEqual({
            actions: [actionPath], errors: [],
        }));
        expect(Modal.alert).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages).toMatchObject([{ localId, rawRecord }]);
    });

});
