import { fireAndForget } from '@/utils/system/fireAndForget';

export type AuthCredentialsInvalidationEvent = Readonly<{
    serverId: string;
    serverUrl: string;
}>;

export type AuthCredentialsInvalidationInput = Readonly<{
    serverId: string;
    serverUrl: string;
    token?: string;
}>;

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

export function notifyAuthCredentialsInvalidated(event: AuthCredentialsInvalidationInput): void {
    const payload: AuthCredentialsInvalidationEvent = {
        serverId: event.serverId,
        serverUrl: event.serverUrl,
    };
    for (const listener of listeners) {
        fireAndForget(
            Promise.resolve().then(() => listener(payload)),
            { tag: 'authCredentialsInvalidation.listener' },
        );
    }
}
