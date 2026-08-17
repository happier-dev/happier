import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    show: vi.fn(),
    push: vi.fn(),
    abandon: vi.fn(),
    recoverRejectedCredential: vi.fn(),
    loginWithCredentials: vi.fn(),
    setActiveServer: vi.fn(),
    profiles: [] as ReadonlyArray<Readonly<{
        id: string;
        serverUrl: string;
    }>>,
}));

vi.mock('expo-router', () => ({
    router: { push: mocks.push },
}));

vi.mock('@/modal', () => ({
    Modal: { show: mocks.show },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    setActiveServer: mocks.setActiveServer,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => mocks.profiles,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    getCurrentAuth: () => ({
        loginWithCredentials:
            mocks.loginWithCredentials,
    }),
}));

vi.mock(
    '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth',
    () => ({
        abandonAccountEncryptionFirstKeyExternalAuth:
            mocks.abandon,
        recoverAccountEncryptionFirstKeyRejectedCredential:
            mocks.recoverRejectedCredential,
    }),
);

import {
    presentFirstKeyCredentialLifecycle,
} from './presentFirstKeyCredentialLifecycle';

type ShownConfig = Readonly<{
    props: Readonly<{
        finish: () => Promise<
            Readonly<{
                kind:
                    | 'completed'
                    | 'recovery_failed';
            }>
        >;
        abandon: () => Promise<
            Readonly<{
                kind:
                    | 'completed'
                    | 'recovery_failed';
            }>
        >;
        onSettled: (
            outcome:
                | 'finish'
                | 'abandon'
                | 'keep',
        ) => void;
    }>;
    onRequestClose: () => void;
    onHostUnmount: () => void;
}>;

function shownConfig(): ShownConfig {
    const config = mocks.show.mock.calls.at(-1)?.[0];
    if (!config) {
        throw new Error('Expected recovery modal');
    }
    return config as ShownConfig;
}

function retainedResult() {
    return {
        kind: 'finish_encryption_setup' as const,
        recovery: {} as never,
    };
}

describe('presentFirstKeyCredentialLifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.profiles = [];
        mocks.recoverRejectedCredential
            .mockResolvedValue({
                kind: 'not_applicable',
            });
    });

    it('settles a safe close or host unmount without abandoning custody', async () => {
        const run = vi.fn(async () =>
            retainedResult()
        );
        const afterAbandon = vi.fn();

        const closed =
            presentFirstKeyCredentialLifecycle({
                run,
                afterAbandon,
            });
        await vi.waitFor(() => {
            expect(mocks.show).toHaveBeenCalledTimes(1);
        });
        shownConfig().onHostUnmount();
        await closed;

        expect(mocks.abandon).not.toHaveBeenCalled();
        expect(afterAbandon).not.toHaveBeenCalled();
    });

    it('awaits real finish recovery and presents completion only after the modal settles', async () => {
        const finish = vi.fn(async () => ({
            kind: 'completed' as const,
        }));
        const onFinishCompleted = vi.fn();
        const presented =
            presentFirstKeyCredentialLifecycle({
                run: async () => retainedResult(),
                finish,
                onFinishCompleted,
            });
        await vi.waitFor(() => {
            expect(mocks.show).toHaveBeenCalledTimes(1);
        });
        const config = shownConfig();

        await expect(
            config.props.finish(),
        ).resolves.toEqual({ kind: 'completed' });
        expect(onFinishCompleted).not.toHaveBeenCalled();

        config.props.onSettled('finish');
        await presented;
        expect(finish).toHaveBeenCalledTimes(1);
        expect(onFinishCompleted).toHaveBeenCalledTimes(1);
    });

    it('activates the exact retained server before routing the default Finish action', async () => {
        mocks.profiles = [{
            id: 'server-b',
            serverUrl:
                'https://server-b.example.test',
        }];
        const presented =
            presentFirstKeyCredentialLifecycle({
                run: async () => ({
                    kind:
                        'finish_encryption_setup',
                    recovery: {
                        serverId: 'server-b',
                        serverUrl:
                            'https://server-b.example.test',
                    } as never,
                }),
            });
        await vi.waitFor(() => {
            expect(mocks.show).toHaveBeenCalledTimes(1);
        });
        const config = shownConfig();

        await expect(
            config.props.finish(),
        ).resolves.toEqual({ kind: 'completed' });
        expect(mocks.setActiveServer)
            .toHaveBeenCalledWith({
                serverId: 'server-b',
                scope: 'device',
            });
        expect(
            mocks.setActiveServer
                .mock.invocationCallOrder[0],
        ).toBeLessThan(
            mocks.push.mock.invocationCallOrder[0]!,
        );
        expect(
            mocks.recoverRejectedCredential,
        ).toHaveBeenCalledWith({
            recovery:
                expect.objectContaining({
                    serverId: 'server-b',
                    serverUrl:
                        'https://server-b.example.test',
                }),
            persistCredentials:
                expect.any(Function),
        });
        config.props.onSettled('finish');
        await presented;
    });

    it('uses Account-bound recovery for rejected first-key credentials before routing to recovery-key setup', async () => {
        mocks.profiles = [{
            id: 'server-b',
            serverUrl:
                'https://server-b.example.test',
        }];
        mocks.recoverRejectedCredential
            .mockImplementationOnce(
                async ({ persistCredentials }) => {
                    await persistCredentials(
                        {
                            token: 'recovered-token',
                            secret: 'recovered-secret',
                        },
                        {
                            firstKeyRecoveryAuthorization:
                                {} as never,
                        },
                    );
                    return {
                        kind: 'completed',
                        mode: 'e2ee',
                        returnTo:
                            '/settings/account',
                    };
                },
            );
        mocks.loginWithCredentials
            .mockResolvedValue({
                kind: 'completed',
            });
        const recovery = {
            serverId: 'server-b',
            serverUrl:
                'https://server-b.example.test',
        } as never;
        const presented =
            presentFirstKeyCredentialLifecycle({
                run: async () => ({
                    kind:
                        'finish_encryption_setup',
                    recovery,
                }),
            });
        await vi.waitFor(() => {
            expect(mocks.show).toHaveBeenCalledTimes(1);
        });

        await expect(
            shownConfig().props.finish(),
        ).resolves.toEqual({ kind: 'completed' });
        expect(
            mocks.loginWithCredentials,
        ).toHaveBeenCalledWith(
            {
                token: 'recovered-token',
                secret: 'recovered-secret',
            },
            expect.anything(),
        );
        expect(mocks.push)
            .toHaveBeenCalledWith(
                '/settings/account',
            );
        shownConfig().onHostUnmount();
        await presented;
    });

    it('keeps the modal and custody when Account-bound Finish recovery fails', async () => {
        mocks.profiles = [{
            id: 'server-b',
            serverUrl:
                'https://server-b.example.test',
        }];
        mocks.recoverRejectedCredential
            .mockResolvedValueOnce({
                kind: 'recovery_failed',
            });
        const presented =
            presentFirstKeyCredentialLifecycle({
                run: async () => ({
                    kind:
                        'finish_encryption_setup',
                    recovery: {
                        serverId: 'server-b',
                        serverUrl:
                            'https://server-b.example.test',
                    } as never,
                }),
            });
        await vi.waitFor(() => {
            expect(mocks.show).toHaveBeenCalledTimes(1);
        });

        await expect(
            shownConfig().props.finish(),
        ).resolves.toEqual({
            kind: 'recovery_failed',
        });
        expect(mocks.push).not.toHaveBeenCalled();
        shownConfig().onRequestClose();
        await presented;
    });

    it('fails the default Finish action safely when its retained target is unavailable', async () => {
        const presented =
            presentFirstKeyCredentialLifecycle({
                run: async () => ({
                    kind:
                        'finish_encryption_setup',
                    recovery: {
                        serverId: 'missing',
                        serverUrl:
                            'https://missing.example.test',
                    } as never,
                }),
            });
        await vi.waitFor(() => {
            expect(mocks.show).toHaveBeenCalledTimes(1);
        });

        await expect(
            shownConfig().props.finish(),
        ).resolves.toEqual({
            kind: 'recovery_failed',
        });
        expect(mocks.setActiveServer)
            .not.toHaveBeenCalled();
        expect(mocks.push).not.toHaveBeenCalled();
        shownConfig().onRequestClose();
        await presented;
    });

    it('retries exact abandonment without clearing the opaque handle twice after the clear succeeded', async () => {
        mocks.abandon
            .mockResolvedValueOnce({
                kind: 'recovery_failed',
            })
            .mockResolvedValueOnce({
                kind: 'abandoned',
            });
        const afterAbandon = vi.fn()
            .mockResolvedValueOnce({
                kind: 'recovery_failed',
            })
            .mockResolvedValueOnce({
                kind: 'completed',
            });
        const onCompleted = vi.fn();
        const presented =
            presentFirstKeyCredentialLifecycle({
                run: async () => retainedResult(),
                afterAbandon,
                onCompleted,
            });
        await vi.waitFor(() => {
            expect(mocks.show).toHaveBeenCalledTimes(1);
        });
        const config = shownConfig();

        await expect(
            config.props.abandon(),
        ).resolves.toEqual({
            kind: 'recovery_failed',
        });
        await expect(
            config.props.abandon(),
        ).resolves.toEqual({
            kind: 'recovery_failed',
        });
        await expect(
            config.props.abandon(),
        ).resolves.toEqual({
            kind: 'completed',
        });
        expect(mocks.abandon).toHaveBeenCalledTimes(2);
        expect(afterAbandon).toHaveBeenCalledTimes(2);

        config.props.onSettled('abandon');
        await presented;
        expect(onCompleted).toHaveBeenCalledTimes(1);
    });
});
