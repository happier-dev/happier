import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createDeferred, renderScreen } from '@/dev/testkit';
import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installPublicShareViewerCommonModuleMocks } from './publicShareViewerTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class { } };

const serverFetchSpy = vi.fn();
const decryptDataKeyFromPublicShareSpy = vi.fn();
const transcriptListSpy = vi.fn();
const routeState = {
    params: { token: 'tok-1' },
    listeners: new Set<() => void>(),
    reset() {
        this.params = { token: 'tok-1' };
    },
    setToken(token: string) {
        this.params = { token };
        for (const listener of this.listeners) listener();
    },
    subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    },
};


vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const routerMock = { back: vi.fn(), push: vi.fn(), replace: vi.fn() };
installPublicShareViewerCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const mock = createExpoRouterMock({
            router: routerMock,
            params: () => routeState.params,
        }).module;
        return {
            ...mock,
            useLocalSearchParams: () => React.useSyncExternalStore(
                (listener) => routeState.subscribe(listener),
                () => routeState.params,
                () => routeState.params,
            ),
        };
    },
});

vi.mock('@/sync/http/client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/http/client')>();
    serverFetchSpy.mockImplementation(actual.serverFetch);
    return {
        ...actual,
        serverFetch: serverFetchSpy,
    };
});

vi.mock('@/sync/encryption/publicShareEncryption', () => ({
    decryptDataKeyFromPublicShare: decryptDataKeyFromPublicShareSpy,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 'auth-token' } }),
}));

vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
    ChatHeaderView: () => null,
}));

vi.mock('@/components/sessions/transcript/TranscriptList', () => ({
    TranscriptList: (props: any) => {
        transcriptListSpy(props);
        return React.createElement('TranscriptList', props);
    },
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 64,
}));

vi.mock('@/components/ui/layout/useChromeSafeAreaInsets', () => ({
    useChromeSafeAreaInsets: () => ({ top: 20, bottom: 0, left: 0, right: 0 }),
}));

function createEmptyTurnDiffInput() {
    return {
        files: [],
        _happier: {
            sessionChangeScope: 'turn',
            workspaceMutationSignal: 'turn-change-set',
            turnId: 'turn-public-share-1',
            sessionId: 's1',
            provider: 'codex',
            rawToolName: 'RepositoryCheckpointDiff',
            canonicalToolName: 'Diff',
            source: 'scm_checkpoint',
            confidence: 'exact',
            turnStatus: 'completed',
            seqRange: {
                startSeqInclusive: 1,
                endSeqInclusive: 2,
            },
        },
    };
}

describe('PublicShareViewerScreen (plaintext)', () => {
    beforeEach(() => {
        routeState.reset();
        serverFetchSpy.mockReset();
        decryptDataKeyFromPublicShareSpy.mockReset();
        transcriptListSpy.mockClear();
    });

    it('renders a plaintext layout-v1 shared-only response without owner Agent fields', async () => {
        serverFetchSpy
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    session: {
                        id: 's1',
                        seq: 1,
                        encryptionMode: 'plain',
                        createdAt: 1,
                        updatedAt: 2,
                        active: true,
                        activeAt: 2,
                        metadataLayoutVersion: 1,
                        metadata: JSON.stringify({
                            v: 1,
                            summary: { text: 'Plain shared session', updatedAt: 2 },
                        }),
                        metadataVersion: 1,
                    },
                    owner: { id: 'u1', username: 'alice', firstName: null, lastName: null, avatar: null },
                    accessLevel: 'view',
                    encryptedDataKey: null,
                    isConsentRequired: false,
                    messagesAccessToken: 'messages-token-1',
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    messages: [
                        {
                            id: 'm1',
                            seq: 1,
                            localId: null,
                            content: {
                                t: 'plain',
                                v: { role: 'user', content: { type: 'text', text: 'hello' } },
                            },
                            createdAt: 3,
                            updatedAt: 3,
                        },
                    ],
                }),
            });

        const { default: PublicShareViewerScreen } = await import('@/app/(app)/share/[token]');

        await renderScreen(<PublicShareViewerScreen />);

        // Allow async effect to resolve.
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(decryptDataKeyFromPublicShareSpy).not.toHaveBeenCalled();
        expect(serverFetchSpy).toHaveBeenCalledWith(
            '/v1/public-share/tok-1',
            expect.anything(),
            expect.objectContaining({ includeAuth: false }),
        );
        expect(serverFetchSpy).toHaveBeenCalledWith(
            '/v1/public-share/tok-1/messages',
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({
                    Authorization: 'Bearer auth-token',
                    'x-public-share-messages-access-token': 'messages-token-1',
                }),
            }),
            expect.objectContaining({ includeAuth: false }),
        );
        expect(transcriptListSpy).toHaveBeenCalled();
        const last = transcriptListSpy.mock.calls[transcriptListSpy.mock.calls.length - 1]?.[0];
        expect(last?.datasetKey).toEqual(expect.any(String));
        expect(last.datasetKey).not.toContain('tok-1');
    });

    it('offsets transcript content below the absolute share header', async () => {
        transcriptListSpy.mockClear();
        serverFetchSpy.mockReset();

        serverFetchSpy
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    session: {
                        id: 's1',
                        seq: 1,
                        encryptionMode: 'plain',
                        createdAt: 1,
                        updatedAt: 2,
                        active: true,
                        activeAt: 2,
                        metadata: JSON.stringify({ path: '/repo', host: 'devbox', name: 'Plain Session' }),
                        metadataVersion: 1,
                        agentState: JSON.stringify({}),
                        agentStateVersion: 1,
                    },
                    owner: { id: 'u1', username: 'alice', firstName: null, lastName: null, avatar: null },
                    accessLevel: 'view',
                    encryptedDataKey: null,
                    isConsentRequired: false,
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ messages: [] }),
            });

        const { default: PublicShareViewerScreen } = await import('@/app/(app)/share/[token]');

        const screen = await renderScreen(<PublicShareViewerScreen />);
        await flushHookEffects({ cycles: 1, turns: 1 });

        const headerOffset = 84;
        const transcriptContainers = screen.findAll((node) => {
            const style = node.props?.style;
            if (Array.isArray(style)) {
                return style.some((entry) => entry?.paddingTop === headerOffset);
            }
            return style?.paddingTop === headerOffset;
        });
        expect(transcriptContainers).toHaveLength(1);
    });

    it('normalizes and reduces messages in deterministic oldest-first order by seq when available', async () => {
        transcriptListSpy.mockClear();
        serverFetchSpy.mockReset();

        serverFetchSpy
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    session: {
                        id: 's1',
                        seq: 1,
                        encryptionMode: 'plain',
                        createdAt: 1,
                        updatedAt: 2,
                        active: true,
                        activeAt: 2,
                        metadata: JSON.stringify({ path: '/repo', host: 'devbox', name: 'Plain Session' }),
                        metadataVersion: 1,
                        agentState: JSON.stringify({}),
                        agentStateVersion: 1,
                    },
                    owner: { id: 'u1', username: 'alice', firstName: null, lastName: null, avatar: null },
                    accessLevel: 'view',
                    encryptedDataKey: null,
                    isConsentRequired: false,
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    messages: [
                        {
                            id: 'm2',
                            seq: 2,
                            localId: null,
                            content: {
                                t: 'plain',
                                v: { role: 'user', content: { type: 'text', text: 'second' } },
                            },
                            createdAt: 1,
                            updatedAt: 1,
                        },
                        {
                            id: 'm1',
                            seq: 1,
                            localId: null,
                            content: {
                                t: 'plain',
                                v: { role: 'user', content: { type: 'text', text: 'first' } },
                            },
                            createdAt: 100,
                            updatedAt: 100,
                        },
                    ],
                }),
            });

        const { default: PublicShareViewerScreen } = await import('@/app/(app)/share/[token]');

        await renderScreen(<PublicShareViewerScreen />);

        // Allow async effect to resolve.
        await flushHookEffects({ cycles: 1, turns: 1 });

        const last = transcriptListSpy.mock.calls[transcriptListSpy.mock.calls.length - 1]?.[0];
        const seqs = Array.isArray(last?.messages) ? last.messages.map((m: any) => (m as any)?.seq ?? null) : [];
        expect(seqs).toEqual([1, 2]);
    });

    it('suppresses empty canonical turn diff call/result pairs from newest-first public share pages', async () => {
        transcriptListSpy.mockClear();
        serverFetchSpy.mockReset();

        const callId = 'public-share-empty-diff';
        serverFetchSpy
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    session: {
                        id: 's1',
                        seq: 2,
                        encryptionMode: 'plain',
                        createdAt: 1,
                        updatedAt: 2,
                        active: true,
                        activeAt: 2,
                        metadata: JSON.stringify({ path: '/repo', host: 'devbox', name: 'Plain Session' }),
                        metadataVersion: 1,
                        agentState: JSON.stringify({}),
                        agentStateVersion: 1,
                    },
                    owner: { id: 'u1', username: 'alice', firstName: null, lastName: null, avatar: null },
                    accessLevel: 'view',
                    encryptedDataKey: null,
                    isConsentRequired: false,
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    messages: [
                        {
                            id: 'm-result',
                            seq: 2,
                            localId: null,
                            content: {
                                t: 'plain',
                                v: {
                                    role: 'agent',
                                    content: {
                                        type: 'acp',
                                        agentId: 'codex',
                                        data: {
                                            type: 'tool-result',
                                            callId,
                                            output: JSON.stringify({ status: 'completed', files: [] }),
                                            id: 'tool-result-public-share',
                                        },
                                    },
                                },
                            },
                            createdAt: 20,
                            updatedAt: 20,
                        },
                        {
                            id: 'm-call',
                            seq: 1,
                            localId: null,
                            content: {
                                t: 'plain',
                                v: {
                                    role: 'agent',
                                    content: {
                                        type: 'acp',
                                        agentId: 'codex',
                                        data: {
                                            type: 'tool-call',
                                            callId,
                                            name: 'Diff',
                                            input: JSON.stringify(createEmptyTurnDiffInput()),
                                            id: 'tool-call-public-share',
                                        },
                                    },
                                },
                            },
                            createdAt: 10,
                            updatedAt: 10,
                        },
                    ],
                }),
            });

        const { default: PublicShareViewerScreen } = await import('@/app/(app)/share/[token]');

        await renderScreen(<PublicShareViewerScreen />);
        await flushHookEffects({ cycles: 1, turns: 1 });

        const last = transcriptListSpy.mock.calls[transcriptListSpy.mock.calls.length - 1]?.[0];
        expect(last?.messages).toEqual([]);
    });

    it('suppresses non-structured event-role output rows from public share transcripts', async () => {
        transcriptListSpy.mockClear();
        serverFetchSpy.mockReset();

        serverFetchSpy
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    session: {
                        id: 's1',
                        seq: 1,
                        encryptionMode: 'plain',
                        createdAt: 1,
                        updatedAt: 2,
                        active: true,
                        activeAt: 2,
                        metadata: JSON.stringify({ path: '/repo', host: 'devbox', name: 'Plain Session' }),
                        metadataVersion: 1,
                        agentState: JSON.stringify({}),
                        agentStateVersion: 1,
                    },
                    owner: { id: 'u1', username: 'alice', firstName: null, lastName: null, avatar: null },
                    accessLevel: 'view',
                    encryptedDataKey: null,
                    isConsentRequired: false,
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    messages: [{
                        id: 'm-event',
                        seq: 1,
                        localId: null,
                        messageRole: 'event',
                        content: {
                            t: 'plain',
                            v: {
                                role: 'agent',
                                content: {
                                    type: 'output',
                                    data: {
                                        type: 'assistant',
                                        uuid: 'event-uuid',
                                        message: {
                                            role: 'assistant',
                                            content: [{ type: 'text', text: 'Transport status' }],
                                        },
                                    },
                                },
                            },
                        },
                        createdAt: 10,
                        updatedAt: 10,
                    }],
                }),
            });

        const { default: PublicShareViewerScreen } = await import('@/app/(app)/share/[token]');

        await renderScreen(<PublicShareViewerScreen />);
        await flushHookEffects({ cycles: 1, turns: 1 });

        const last = transcriptListSpy.mock.calls[transcriptListSpy.mock.calls.length - 1]?.[0];
        expect(last?.messages).toEqual([]);
    });

    it('skips malformed plaintext share messages and still renders the remaining messages', async () => {
        transcriptListSpy.mockClear();
        serverFetchSpy.mockReset();

        serverFetchSpy
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    session: {
                        id: 's1',
                        seq: 1,
                        encryptionMode: 'plain',
                        createdAt: 1,
                        updatedAt: 2,
                        active: true,
                        activeAt: 2,
                        metadata: JSON.stringify({ path: '/repo', host: 'devbox', name: 'Plain Session' }),
                        metadataVersion: 1,
                        agentState: JSON.stringify({}),
                        agentStateVersion: 1,
                    },
                    owner: { id: 'u1', username: 'alice', firstName: null, lastName: null, avatar: null },
                    accessLevel: 'view',
                    encryptedDataKey: null,
                    isConsentRequired: false,
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    messages: [
                        {
                            id: 'bad',
                            seq: 1,
                            localId: null,
                            content: { t: 'encrypted', c: 'unexpected' },
                            createdAt: 3,
                            updatedAt: 3,
                        },
                        {
                            id: 'm1',
                            seq: 2,
                            localId: null,
                            content: {
                                t: 'plain',
                                v: { role: 'user', content: { type: 'text', text: 'hello' } },
                            },
                            createdAt: 4,
                            updatedAt: 4,
                        },
                    ],
                }),
            });

        const { default: PublicShareViewerScreen } = await import('@/app/(app)/share/[token]');

        await renderScreen(<PublicShareViewerScreen />);
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(transcriptListSpy).toHaveBeenCalled();
        const last = transcriptListSpy.mock.calls[transcriptListSpy.mock.calls.length - 1]?.[0];
        const seqs = Array.isArray(last?.messages) ? last.messages.map((m: any) => (m as any)?.seq ?? null) : [];
        expect(seqs).toEqual([2]);
    });

    it('ignores an out-of-order response from token A after same-session token B has loaded', async () => {
        routeState.params = { token: 'token-a-secret' };
        const tokenARoot = createDeferred<any>();
        const tokenAMessages = createDeferred<any>();
        const tokenBRoot = createDeferred<any>();
        const tokenBMessages = createDeferred<any>();

        const shareResponse = (name: string, messagesAccessToken: string) => ({
            ok: true,
            status: 200,
            json: async () => ({
                session: {
                    id: 'same-session',
                    seq: 1,
                    encryptionMode: 'plain',
                    createdAt: 1,
                    updatedAt: 2,
                    active: true,
                    activeAt: 2,
                    metadata: JSON.stringify({ path: '/repo', host: 'devbox', name }),
                    metadataVersion: 1,
                    agentState: JSON.stringify({}),
                    agentStateVersion: 1,
                },
                owner: { id: 'u1', username: 'alice', firstName: null, lastName: null, avatar: null },
                accessLevel: 'view',
                encryptedDataKey: null,
                isConsentRequired: false,
                messagesAccessToken,
            }),
        });
        const messagesResponse = (id: string, text: string) => ({
            ok: true,
            status: 200,
            json: async () => ({
                messages: [{
                    id,
                    seq: 1,
                    localId: null,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text } } },
                    createdAt: 3,
                    updatedAt: 3,
                }],
            }),
        });

        serverFetchSpy
            .mockImplementationOnce(() => tokenARoot.promise)
            .mockImplementationOnce(() => tokenAMessages.promise)
            .mockImplementationOnce(() => tokenBRoot.promise)
            .mockImplementationOnce(() => tokenBMessages.promise);

        const { default: PublicShareViewerScreen } = await import('@/app/(app)/share/[token]');
        await renderScreen(<PublicShareViewerScreen />);
        await act(async () => {
            tokenARoot.resolve(shareResponse('Token A', 'messages-a'));
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(serverFetchSpy).toHaveBeenCalledWith(
            '/v1/public-share/token-a-secret/messages',
            expect.anything(),
            expect.anything(),
        );

        await act(async () => {
            routeState.setToken('token-b-secret');
        });
        await act(async () => {
            tokenBRoot.resolve(shareResponse('Token B', 'messages-b'));
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        await act(async () => {
            tokenBMessages.resolve(messagesResponse('message-b', 'from B'));
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const tokenBProps = transcriptListSpy.mock.calls[transcriptListSpy.mock.calls.length - 1]?.[0];
        expect(tokenBProps).toEqual(expect.objectContaining({
            metadata: expect.objectContaining({ name: 'Token B' }),
            sessionId: 'same-session',
        }));
        expect(tokenBProps.messages.map((message: any) => message.realID)).toEqual(['message-b']);

        tokenAMessages.resolve(messagesResponse('message-a', 'from A'));
        await flushHookEffects({ cycles: 2, turns: 2 });

        const finalProps = transcriptListSpy.mock.calls[transcriptListSpy.mock.calls.length - 1]?.[0];
        expect(finalProps.metadata).toEqual(expect.objectContaining({ name: 'Token B' }));
        expect(finalProps.messages.map((message: any) => message.realID)).toEqual(['message-b']);
        expect(finalProps.datasetKey).toEqual(expect.any(String));
        expect(finalProps.datasetKey).toBe(tokenBProps.datasetKey);
        expect(finalProps.datasetKey).not.toContain('token-a-secret');
        expect(finalProps.datasetKey).not.toContain('token-b-secret');
    });

    it('walks older public share pages from the served cursor on the already-authorized grant', async () => {
        // A share longer than one page must not begin mid-conversation: the viewer follows
        // `nextBeforeSeq` and merges the older page UNDER the rows already on screen.
        transcriptListSpy.mockClear();
        serverFetchSpy.mockReset();

        const plainText = (text: string) => ({
            t: 'plain',
            v: { role: 'user', content: { type: 'text', text } },
        });

        serverFetchSpy
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    session: {
                        id: 's1',
                        seq: 4,
                        encryptionMode: 'plain',
                        createdAt: 1,
                        updatedAt: 2,
                        active: true,
                        activeAt: 2,
                        metadata: JSON.stringify({ path: '/repo', host: 'devbox', name: 'Plain Session' }),
                        metadataVersion: 1,
                    },
                    owner: { id: 'u1', username: 'alice', firstName: null, lastName: null, avatar: null },
                    accessLevel: 'view',
                    encryptedDataKey: null,
                    isConsentRequired: false,
                    messagesAccessToken: 'messages-token-paged',
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    messages: [
                        { id: 'm3', seq: 3, localId: null, content: plainText('newest'), createdAt: 30, updatedAt: 30 },
                    ],
                    hasMore: true,
                    nextBeforeSeq: 3,
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    messages: [
                        { id: 'm2', seq: 2, localId: null, content: plainText('middle'), createdAt: 20, updatedAt: 20 },
                        { id: 'm1', seq: 1, localId: null, content: plainText('oldest'), createdAt: 10, updatedAt: 10 },
                    ],
                    hasMore: false,
                    nextBeforeSeq: null,
                }),
            });

        const { default: PublicShareViewerScreen } = await import('@/app/(app)/share/[token]');

        await renderScreen(<PublicShareViewerScreen />);
        await flushHookEffects({ cycles: 1, turns: 1 });

        const first = transcriptListSpy.mock.calls[transcriptListSpy.mock.calls.length - 1]?.[0];
        expect(first.messages.map((m: any) => m.text)).toEqual(['newest']);
        expect(typeof first.loadOlder).toBe('function');

        let olderResult: any;
        await act(async () => {
            olderResult = await first.loadOlder();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(olderResult).toEqual({ loaded: 2, hasMore: false, status: 'no_more' });
        expect(serverFetchSpy).toHaveBeenLastCalledWith(
            '/v1/public-share/tok-1/messages?beforeSeq=3',
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({
                    'x-public-share-messages-access-token': 'messages-token-paged',
                }),
            }),
            expect.objectContaining({ includeAuth: false }),
        );

        const afterOlder = transcriptListSpy.mock.calls[transcriptListSpy.mock.calls.length - 1]?.[0];
        expect(afterOlder.messages.map((m: any) => m.text)).toEqual(['oldest', 'middle', 'newest']);
    });

    it('reports a failed older public share page as retryable instead of a loaded empty page', async () => {
        transcriptListSpy.mockClear();
        serverFetchSpy.mockReset();

        serverFetchSpy
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    session: {
                        id: 's1',
                        seq: 2,
                        encryptionMode: 'plain',
                        createdAt: 1,
                        updatedAt: 2,
                        active: true,
                        activeAt: 2,
                        metadata: JSON.stringify({ path: '/repo', host: 'devbox', name: 'Plain Session' }),
                        metadataVersion: 1,
                    },
                    owner: { id: 'u1', username: 'alice', firstName: null, lastName: null, avatar: null },
                    accessLevel: 'view',
                    encryptedDataKey: null,
                    isConsentRequired: false,
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    messages: [{
                        id: 'm2',
                        seq: 2,
                        localId: null,
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'newest' } } },
                        createdAt: 20,
                        updatedAt: 20,
                    }],
                    hasMore: true,
                    nextBeforeSeq: 2,
                }),
            })
            .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });

        const { default: PublicShareViewerScreen } = await import('@/app/(app)/share/[token]');

        await renderScreen(<PublicShareViewerScreen />);
        await flushHookEffects({ cycles: 1, turns: 1 });

        const first = transcriptListSpy.mock.calls[transcriptListSpy.mock.calls.length - 1]?.[0];
        let olderResult: any;
        await act(async () => {
            olderResult = await first.loadOlder();
        });

        expect(olderResult).toEqual({ loaded: 0, hasMore: true, status: 'retryable_error' });
        const afterFailure = transcriptListSpy.mock.calls[transcriptListSpy.mock.calls.length - 1]?.[0];
        // Rows and the cursor are retained, so the same page can be retried.
        expect(afterFailure.messages.map((m: any) => m.text)).toEqual(['newest']);
    });
});
