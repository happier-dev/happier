import { runtimeFetch } from '@/utils/system/runtimeFetch';

import {
    reportServerUnreachable,
    waitForServerReachable,
} from './serverReachabilitySupervisorPool';
import { readServerReachabilityWaitTimeoutMs } from './serverReachabilityTuning';

export async function runtimeFetchWithServerReachability(params: Readonly<{
    serverUrl: string;
    token: string | null;
    url: string;
    init: RequestInit;
    timeoutMs?: number;
    signal?: AbortSignal;
}>): Promise<Response> {
    await waitForServerReachable({
        serverUrl: params.serverUrl,
        token: params.token,
        signal: params.signal ?? (params.init.signal ?? undefined),
        timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : readServerReachabilityWaitTimeoutMs(),
        acceptAuthFailed: true,
    });

    try {
        return await runtimeFetch(params.url, params.init);
    } catch (error) {
        reportServerUnreachable(params.serverUrl, error);
        throw error;
    }
}
