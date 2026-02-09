import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { syncSwitchServer } from '@/sync/sync';
import { abortServerFetches } from '@/sync/http/client';

let activeSwitchPromise: Promise<AuthCredentials | null> | null = null;
let lastAppliedGeneration = -1;
let requestedGeneration = -1;

async function applyPendingServerSwitches(): Promise<AuthCredentials | null> {
    while (true) {
        const snapshot = getActiveServerSnapshot();
        const targetGeneration = Math.max(requestedGeneration, snapshot.generation);

        if (targetGeneration <= lastAppliedGeneration) {
            return await TokenStorage.getCredentials();
        }

        requestedGeneration = targetGeneration;
        abortServerFetches();
        const credentials = await TokenStorage.getCredentials();
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
