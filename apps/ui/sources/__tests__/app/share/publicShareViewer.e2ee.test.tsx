import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit';
import { describe, expect, it, vi } from 'vitest';
import { installPublicShareViewerCommonModuleMocks } from './publicShareViewerTestHelpers';

import { encodeBase64 } from '@/encryption/base64';
import { AES256Encryption } from '@/sync/encryption/encryptor';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class { } };

const serverFetchSpy = vi.fn();
const decryptDataKeyFromPublicShareSpy = vi.fn();
const transcriptListSpy = vi.fn();

vi.mock('react-native-reanimated', () => ({}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const routerMock = { back: vi.fn(), push: vi.fn(), replace: vi.fn() };
installPublicShareViewerCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: routerMock,
            params: { token: 'tok-1' },
        }).module;
    },
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

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 64,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 20, bottom: 0, left: 0, right: 0 }),
}));

describe('PublicShareViewerScreen (e2ee)', () => {
    it('fails closed when an encrypted share message cannot be decrypted instead of silently skipping it', async () => {
        transcriptListSpy.mockClear();
        serverFetchSpy.mockReset();
        decryptDataKeyFromPublicShareSpy.mockReset();

        const dataKeyOk = new Uint8Array(32).fill(1);
        const dataKeyWrong = new Uint8Array(32).fill(2);

        decryptDataKeyFromPublicShareSpy.mockResolvedValue(dataKeyOk);

        const encryptorOk = new AES256Encryption(dataKeyOk);
        const encryptorWrong = new AES256Encryption(dataKeyWrong);

        const [metadataCiphertextBytes] = await encryptorOk.encrypt([
            { path: '/repo', host: 'devbox', name: 'E2EE Session' },
        ]);
        const metadataCiphertext = encodeBase64(metadataCiphertextBytes, 'base64');

        const [messageCiphertextBytes] = await encryptorWrong.encrypt([
            { role: 'user', content: { type: 'text', text: 'hello' } },
        ]);
        const messageCiphertext = encodeBase64(messageCiphertextBytes, 'base64');

        serverFetchSpy
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    session: {
                        id: 's1',
                        seq: 1,
                        encryptionMode: 'e2ee',
                        createdAt: 1,
                        updatedAt: 2,
                        active: true,
                        activeAt: 2,
                        metadata: metadataCiphertext,
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                    },
                    owner: { id: 'u1', username: 'alice', firstName: null, lastName: null, avatar: null },
                    accessLevel: 'view',
                    encryptedDataKey: 'encrypted-data-key-placeholder',
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
                            content: { t: 'encrypted', c: messageCiphertext },
                            createdAt: 3,
                            updatedAt: 3,
                        },
                    ],
                }),
            });

        const { default: PublicShareViewerScreen } = await import('@/app/(app)/share/[token]');

        await renderScreen(<PublicShareViewerScreen />);
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(decryptDataKeyFromPublicShareSpy).toHaveBeenCalled();
        expect(transcriptListSpy).not.toHaveBeenCalled();
    });
});
