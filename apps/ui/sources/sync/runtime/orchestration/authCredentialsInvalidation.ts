import { fireAndForget } from '@/utils/system/fireAndForget';
import type {
    AccountEncryptionFirstKeyRecoveryHandle,
} from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';

type AuthCredentialsInvalidationServer = Readonly<{
    serverId: string;
    serverUrl: string;
}>;

export type AuthCredentialsInvalidationEvent =
    | (AuthCredentialsInvalidationServer & Readonly<{
        kind: 'credentials_removed';
    }>)
    | (AuthCredentialsInvalidationServer & Readonly<{
        kind: 'first_key_recovery_required';
        recovery: AccountEncryptionFirstKeyRecoveryHandle;
    }>);

type AuthCredentialsInvalidationListener = (event: AuthCredentialsInvalidationEvent) => void | Promise<void>;

const listeners = new Set<AuthCredentialsInvalidationListener>();

export function subscribeAuthCredentialsInvalidation(
    listener: AuthCredentialsInvalidationListener,
): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function notifyAuthCredentialsInvalidated(event: AuthCredentialsInvalidationEvent): void {
    for (const listener of listeners) {
        fireAndForget(
            Promise.resolve().then(() => listener(event)),
            { tag: 'authCredentialsInvalidation.listener' },
        );
    }
}
