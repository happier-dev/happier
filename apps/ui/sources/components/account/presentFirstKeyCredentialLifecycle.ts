import { router } from 'expo-router';

import {
    getCurrentAuth,
    type AuthCredentialLifecycleResult,
} from '@/auth/context/AuthContext';
import {
    abandonAccountEncryptionFirstKeyExternalAuth,
    recoverAccountEncryptionFirstKeyRejectedCredential,
} from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { Modal } from '@/modal';
import {
    listServerProfiles,
} from '@/sync/domains/server/serverProfiles';
import {
    setActiveServer,
} from '@/sync/domains/server/serverRuntime';
import {
    FirstKeyRecoveryModal,
    type FirstKeyRecoveryActionResult,
} from './FirstKeyRecoveryModal';

export async function presentFirstKeyCredentialLifecycle(
    params: Readonly<{
        run: () => Promise<AuthCredentialLifecycleResult>;
        finish?: () => Promise<FirstKeyRecoveryActionResult>;
        afterAbandon?: () => Promise<AuthCredentialLifecycleResult>;
        onFinishCompleted?: () => void | Promise<void>;
        onCompleted?: () => void | Promise<void>;
    }>,
): Promise<void> {
    const result = await params.run();
    if (result.kind === 'completed') {
        await params.onCompleted?.();
        return;
    }
    if (result.kind === 'recovery_failed') return;

    let exactCustodyAbandoned = false;
    const outcome = await new Promise<
        'finish' | 'abandon' | 'keep'
    >((resolve) => {
        let settled = false;
        const settle = (
            nextOutcome: 'finish' | 'abandon' | 'keep',
        ) => {
            if (settled) return;
            settled = true;
            resolve(nextOutcome);
        };
        Modal.show({
            component: FirstKeyRecoveryModal,
            props: {
                finish: params.finish ?? (async (): Promise<
                    FirstKeyRecoveryActionResult
                > => {
                    const targetServerId =
                        result.recovery.serverId;
                    const targetServerUrl =
                        result.recovery.serverUrl;
                    if (
                        !targetServerId
                        || !targetServerUrl
                        || !listServerProfiles().some(
                            (profile) => (
                                profile.id
                                    === targetServerId
                                && profile.serverUrl
                                    === targetServerUrl
                            ),
                        )
                    ) {
                        return {
                            kind:
                                'recovery_failed',
                        };
                    }
                    setActiveServer({
                        serverId: targetServerId,
                        scope: 'device',
                    });
                    const auth = getCurrentAuth();
                    const recovered =
                        await recoverAccountEncryptionFirstKeyRejectedCredential({
                            recovery:
                                result.recovery,
                            persistCredentials:
                                async (
                                    credentials,
                                    options,
                                ) => (
                                    auth
                                        ? await auth
                                            .loginWithCredentials(
                                                credentials,
                                                options,
                                            )
                                        : {
                                            kind:
                                                'recovery_failed',
                                        }
                                ),
                        });
                    if (
                        recovered.kind
                        === 'recovery_failed'
                    ) {
                        return {
                            kind:
                                'recovery_failed',
                        };
                    }
                    router.push('/settings/account');
                    return { kind: 'completed' };
                }),
                abandon: async (): Promise<
                    FirstKeyRecoveryActionResult
                > => {
                    if (!exactCustodyAbandoned) {
                        const abandoned =
                            await abandonAccountEncryptionFirstKeyExternalAuth(
                                result.recovery,
                            );
                        if (abandoned.kind !== 'abandoned') {
                            return {
                                kind:
                                    'recovery_failed',
                            };
                        }
                        exactCustodyAbandoned = true;
                    }
                    const mutation = await (
                        params.afterAbandon
                            ? params.afterAbandon()
                            : params.run()
                    );
                    return mutation.kind === 'completed'
                        ? { kind: 'completed' }
                        : { kind: 'recovery_failed' };
                },
                onSettled: (outcome) => {
                    void settle(outcome);
                },
            },
            onRequestClose: () => {
                void settle('keep');
            },
            onHostUnmount: () => {
                settle('keep');
            },
        });
    });
    if (outcome === 'finish') {
        await params.onFinishCompleted?.();
    } else if (outcome === 'abandon') {
        await params.onCompleted?.();
    }
}
