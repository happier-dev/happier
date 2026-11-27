import { ServerFetchAbortedForServerSwitchError, type ServerFetch } from '@/sync/http/client';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import {
    PluginAvailabilityInvalidResponseError,
    PluginAvailabilityUnavailableError,
    type PluginAvailabilityResponsePhase,
} from '@/sync/domains/plugins/availability/responseFailure';

/** Classify completed Availability reads; HTTP retains its recovery and cancellation lifetime. */
export async function postJson(
    authority: Readonly<{ request: ServerFetch }>,
    path: string,
    body: unknown,
    signal: AbortSignal,
    phase: PluginAvailabilityResponsePhase,
    scope: ServerAccountScope,
    accept?: string,
): Promise<unknown> {
    try {
        const response = await authority.request(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(accept ? { Accept: accept } : {}) },
            body: JSON.stringify(body),
            signal,
        }, { recoveryRead: 'unbounded' });
        if (!response.ok) {
            throw new PluginAvailabilityUnavailableError(phase, scope, response.status);
        }
        return await response.json();
    } catch (error) {
        if (signal.aborted || error instanceof ServerFetchAbortedForServerSwitchError) throw error;
        if (error instanceof SyntaxError) throw new PluginAvailabilityInvalidResponseError(phase, scope);
        if (isTransientConnectivityError(error)) throw new PluginAvailabilityUnavailableError(phase, scope);
        throw error;
    }
}
