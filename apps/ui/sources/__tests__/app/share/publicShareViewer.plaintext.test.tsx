import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class { } };

const serverFetchSpy = vi.fn();
const decryptDataKeyFromPublicShareSpy = vi.fn();
const transcriptListSpy = vi.fn();

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => {
    type PlatformSelectOptions<T> = { web?: T; default?: T };
    return {
        Platform: { OS: 'web', select: <T,>(options: PlatformSelectOptions<T>) => options.web ?? options.default },
        Dimensions: {
            get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
        },
        TurboModuleRegistry: { getEnforcing: () => ({}) },
        View: 'View',
        Text: 'Text',
        ActivityIndicator: 'ActivityIndicator',
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const routerMock = { back: vi.fn(), push: vi.fn(), replace: vi.fn() };
vi.mock('expo-router', () => {
    const Stack: { Screen: () => null } = { Screen: () => null };
    return {
        Stack,
        useLocalSearchParams: () => ({ token: 'tok-1' }),
        useRouter: () => routerMock,
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                textLink: '#00f',
                groupped: { background: '#fff', sectionTitle: '#000' },
                textDestructive: '#f00',
                text: '#000',
                textSecondary: '#666',
                header: { tint: '#000' },
                divider: '#ddd',
                surfaceHigh: '#fff',
                shadow: { color: '#000', opacity: 0.1 },
                status: { error: '#f00' },
                button: { primary: { background: '#000', tint: '#fff' } },
                input: { background: '#fff', text: '#000' },
                permissionButton: { inactive: { background: '#ccc' } },
            },
        },
    }),
    StyleSheet: {
        create: (arg: any) => {
            if (typeof arg === 'function') {
                const theme = {
                    colors: {
                        surface: '#fff',
                        textLink: '#00f',
                        groupped: { background: '#fff', sectionTitle: '#000' },
                        textDestructive: '#f00',
                        text: '#000',
                        textSecondary: '#666',
                        header: { tint: '#000' },
                        divider: '#ddd',
                        surfaceHigh: '#fff',
                        shadow: { color: '#000', opacity: 0.1 },
                        status: { error: '#f00' },
                        button: { primary: { background: '#000', tint: '#fff' } },
                        input: { background: '#fff', text: '#000' },
                        permissionButton: { inactive: { background: '#ccc' } },
                    },
                };
                // Support both `StyleSheet.create((theme) => ...)` and `StyleSheet.create(({ theme }) => ...)`.
                return arg({ ...theme, theme, colors: theme.colors });
            }
            return arg;
        },
    },
}));

vi.mock('@/text', () => ({ t: (key: string) => key }));

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

        await act(async () => {
            renderer.create(<PublicShareViewerScreen />);
        });

        // Allow async effect to resolve.
        await act(async () => {
            await Promise.resolve();
        });

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
});
