import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { syncSwitchServer } from '@/sync/sync';
import { abortServerFetches } from '@/sync/http/client';

let activeSwitchPromise: Promise<AuthCredentials | null> | null = null;
let lastAppliedGeneration = -1;
let requestedGeneration = -1;

async function resolveCredentialsForActiveServer(
    snapshot: Readonly<ReturnType<typeof getActiveServerSnapshot>>,
): Promise<AuthCredentials | null> {
    if (!snapshot.serverUrl) {
        return await TokenStorage.getCredentials();
    }
    return await TokenStorage.getCredentialsForServerUrl(snapshot.serverUrl, {
        serverId: snapshot.serverId,
    });
}

async function applyPendingServerSwitches(): Promise<AuthCredentials | null> {
    while (true) {
        const snapshot = getActiveServerSnapshot();
        const targetGeneration = Math.max(requestedGeneration, snapshot.generation);

        if (targetGeneration <= lastAppliedGeneration) {
            return await resolveCredentialsForActiveServer(snapshot);
        }

        requestedGeneration = targetGeneration;
        abortServerFetches();
        const credentials = await resolveCredentialsForActiveServer(snapshot);
        await syncSwitchServer(credentials);
        lastAppliedGeneration = targetGeneration;
    }
}

export async function switchConnectionToActiveServer(): Promise<AuthCredentials | null> {
    const snapshot = getActiveServerSnapshot();
    requestedGeneration = Math.max(requestedGeneration, snapshot.generation);
    if (!activeSwitchPromise) {
        activeSwitchPromise = applyPendingServerSwitches();
    }

    try {
        return await activeSwitchPromise;
    } finally {
        activeSwitchPromise = null;
    }
}
