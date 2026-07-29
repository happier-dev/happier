import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit';
import { describe, expect, it, vi } from 'vitest';
import { installPublicShareViewerCommonModuleMocks } from './publicShareViewerTestHelpers';

import { encodeBase64 } from '@/encryption/base64';
import { AES256Encryption } from '@/sync/encryption/encryptor';
import {
    ExternalSessionOperationSharedPresentationV1Schema,
    projectSessionSharedMetadataV1,
} from '@happier-dev/protocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class { } };

const serverFetchSpy = vi.fn();
const decryptDataKeyFromPublicShareSpy = vi.fn();
const transcriptListSpy = vi.fn();


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

function createEmptyTurnDiffInput() {
    return {
        files: [],
        _happier: {
            sessionChangeScope: 'turn',
            workspaceMutationSignal: 'turn-change-set',
            turnId: 'turn-public-share-e2ee-1',
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

function createPublicExternalSessionOperationPresentation() {
    return ExternalSessionOperationSharedPresentationV1Schema.parse({
        v: 1,
        operationId: 'operation-public-safe-1',
        revision: 4,
        kind: 'materialize',
        status: 'running',
        phase: 'validating',
    });
}

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

        const screen = await renderScreen(<PublicShareViewerScreen />);
        try {
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(decryptDataKeyFromPublicShareSpy).toHaveBeenCalled();
            expect(transcriptListSpy).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
        }
    });

    it('suppresses encrypted empty canonical turn diff pairs from newest-first public share pages', async () => {
        transcriptListSpy.mockClear();
        serverFetchSpy.mockReset();
        decryptDataKeyFromPublicShareSpy.mockReset();

        const dataKey = new Uint8Array(32).fill(3);
        decryptDataKeyFromPublicShareSpy.mockResolvedValue(dataKey);

        const encryptor = new AES256Encryption(dataKey);
        const externalSessionOperationPresentationV1 =
            createPublicExternalSessionOperationPresentation();
        const [metadataCiphertextBytes] = await encryptor.encrypt([
            projectSessionSharedMetadataV1({
                metadata: {
                    path: '/repo',
                    host: 'devbox',
                    name: 'E2EE Session',
                    externalSessionOperationPresentationV1,
                },
            }),
        ]);
        const metadataCiphertext = encodeBase64(metadataCiphertextBytes, 'base64');

        const callId = 'public-share-e2ee-empty-diff';
        const [resultCiphertextBytes, callCiphertextBytes] = await encryptor.encrypt([
            {
                role: 'agent',
                content: {
                    type: 'acp',
                    agentId: 'codex',
                    data: {
                        type: 'tool-result',
                        callId,
                        output: JSON.stringify({ status: 'completed', files: [] }),
                        id: 'tool-result-public-share-e2ee',
                    },
                },
            },
            {
                role: 'agent',
                content: {
                    type: 'acp',
                    agentId: 'codex',
                    data: {
                        type: 'tool-call',
                        callId,
                        name: 'Diff',
                        input: JSON.stringify(createEmptyTurnDiffInput()),
                        id: 'tool-call-public-share-e2ee',
                    },
                },
            },
        ]);

        serverFetchSpy
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    session: {
                        id: 's1',
                        seq: 2,
                        encryptionMode: 'e2ee',
                        createdAt: 1,
                        updatedAt: 2,
                        active: true,
                        activeAt: 2,
                        metadataLayoutVersion: 1,
                        metadata: metadataCiphertext,
                        metadataVersion: 1,
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
                            id: 'm-result',
                            seq: 2,
                            localId: null,
                            content: { t: 'encrypted', c: encodeBase64(resultCiphertextBytes, 'base64') },
                            createdAt: 20,
                            updatedAt: 20,
                        },
                        {
                            id: 'm-call',
                            seq: 1,
                            localId: null,
                            content: { t: 'encrypted', c: encodeBase64(callCiphertextBytes, 'base64') },
                            createdAt: 10,
                            updatedAt: 10,
                        },
                    ],
                }),
            });

        const { default: PublicShareViewerScreen } = await import('@/app/(app)/share/[token]');

        const screen = await renderScreen(<PublicShareViewerScreen />);
        try {
            await flushHookEffects({ cycles: 1, turns: 2 });

            const last = transcriptListSpy.mock.calls[transcriptListSpy.mock.calls.length - 1]?.[0];
            expect(last?.messages ?? []).toEqual([]);
            expect(last?.metadata?.externalSessionOperationPresentationV1).toEqual(
                externalSessionOperationPresentationV1,
            );
            const publicMetadata = JSON.stringify(last?.metadata);
            expect(publicMetadata).toContain('operation-public-safe-1');
            expect(publicMetadata).not.toContain('operationClaimId');
            expect(publicMetadata).not.toContain('canonicalOwnerEvidence');
            expect(publicMetadata).not.toContain('privateStagingId');
        } finally {
            await screen.unmount();
        }
    });

    it('suppresses encrypted non-structured event-role output rows from public share transcripts', async () => {
        transcriptListSpy.mockClear();
        serverFetchSpy.mockReset();
        decryptDataKeyFromPublicShareSpy.mockReset();

        const dataKey = new Uint8Array(32).fill(4);
        decryptDataKeyFromPublicShareSpy.mockResolvedValue(dataKey);

        const encryptor = new AES256Encryption(dataKey);
        const [metadataCiphertextBytes, messageCiphertextBytes] = await encryptor.encrypt([
            { path: '/repo', host: 'devbox', name: 'E2EE Session' },
            {
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
        ]);
        const metadataCiphertext = encodeBase64(metadataCiphertextBytes, 'base64');

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
                    messages: [{
                        id: 'm-event',
                        seq: 1,
                        localId: null,
                        messageRole: 'event',
                        content: { t: 'encrypted', c: encodeBase64(messageCiphertextBytes, 'base64') },
                        createdAt: 10,
                        updatedAt: 10,
                    }],
                }),
            });

        const { default: PublicShareViewerScreen } = await import('@/app/(app)/share/[token]');

        const screen = await renderScreen(<PublicShareViewerScreen />);
        try {
            await flushHookEffects({ cycles: 1, turns: 2 });

            const last = transcriptListSpy.mock.calls[transcriptListSpy.mock.calls.length - 1]?.[0];
            expect(last?.messages ?? []).toEqual([]);
        } finally {
            await screen.unmount();
        }
    });
});
