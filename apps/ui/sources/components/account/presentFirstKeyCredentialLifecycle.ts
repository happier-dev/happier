import { getCurrentAuth } from '@/auth/context/currentAuth';
import type { AuthCredentialLifecycleResult } from '@/auth/context/AuthContext';
import {
    abandonAccountEncryptionFirstKeyExternalAuth,
    recoverAccountEncryptionFirstKeyRejectedCredential,
    retryPendingAccountEncryptionFirstKeyExternalAuth,
} from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
    FirstKeyRecoveryModal,
    type FirstKeyRecoveryActionResult,
} from './FirstKeyRecoveryModal';

export async function presentFirstKeyCredentialLifecycle(
    params: Readonly<{
        /** `kept`: the mutation deliberately did not go ahead (it already told the person why). */
        run: () => Promise<AuthCredentialLifecycleResult | Readonly<{ kind: 'kept' }>>;
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
    if (result.kind === 'recovery_failed' || result.kind === 'kept') return;

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
                    ) {
                        return {
                            kind:
                                'recovery_failed',
                        };
                    }
                    const auth = getCurrentAuth();
                    if (!auth) {
                        return { kind: 'recovery_failed' };
                    }
                    const target = { serverId: targetServerId, serverUrl: targetServerUrl };
                    const recovered =
                        await recoverAccountEncryptionFirstKeyRejectedCredential({
                            recovery:
                                result.recovery,
                            target,
                            persistCredentials: auth.loginWithCredentials,
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
                    if (recovered.kind === 'not_applicable') {
                        const currentCredentials = await TokenStorage.getCredentialsForServerUrl(targetServerUrl, { serverId: targetServerId });
                        if (!currentCredentials || !await retryPendingAccountEncryptionFirstKeyExternalAuth({
                            currentCredentials, target, persistCredentials: auth.loginWithCredentials,
                        })) return { kind: 'recovery_failed' };
                    }
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
        if (params.onFinishCompleted) await params.onFinishCompleted();
        else if ((await params.run()).kind === 'completed') await params.onCompleted?.();
    } else if (outcome === 'abandon') {
        await params.onCompleted?.();
    }
}
