import { vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { primeServerFeaturesSnapshot, deleteServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storageStore';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { installRealActionExecutorModuleLoader } from '../harness/actionHomesHttpHarness';
import { createWorkflowActionHttpTransport } from './workflowActionHttpTransport';

/** Native fixture installer; the same HTTP response owner is consumed by real source browser journeys. */
export async function installWorkflowActionHttpBoundary(params: Readonly<{
    fixtureResponse: (actionId: string, input: Record<string, unknown>) => Promise<unknown>;
    accountId?: () => string;
    automationDefinitions?: (url: URL, init?: RequestInit) => Promise<Response | undefined>;
    automationRuns?: (url: URL, init?: RequestInit) => Promise<Response>;
}>) {
    const restoreExecutorLoader = await installRealActionExecutorModuleLoader();
    const accountId = params.accountId ?? (() => storage.getState().profileScope?.accountId ?? 'account-a');
    const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async () => ({
        token: `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: accountId() })), 'base64url')}.signature`,
    }));
    const boundary = createWorkflowActionHttpTransport({ ...params, accountId });
    setRuntimeFetch(boundary.fetch);
    return {
        prime() { primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: boundary.features } }); },
        dispose() { restoreExecutorLoader(); resetRuntimeFetch(); credentials.mockRestore(); deleteServerFeaturesSnapshot(); },
    };
}
