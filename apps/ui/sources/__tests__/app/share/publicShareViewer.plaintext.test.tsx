import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit';
import { describe, expect, it, vi } from 'vitest';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class { } };

const serverFetchSpy = vi.fn();
const decryptDataKeyFromPublicShareSpy = vi.fn();
const transcriptListSpy = vi.fn();

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const routerMock = { back: vi.fn(), push: vi.fn(), replace: vi.fn() };
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: routerMock,
        params: { token: 'tok-1' },
    });
    return expoRouterMock.module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/sync/http/client', () => ({
    serverFetch: serverFetchSpy,
}));

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
        return null;
    },
}));

describe('PublicShareViewerScreen (plaintext)', () => {
    it('does not attempt DEK decryption for plaintext sessions', async () => {
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
            expect.anything(),
            expect.objectContaining({ includeAuth: false }),
        );
        expect(transcriptListSpy).toHaveBeenCalled();
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
});
