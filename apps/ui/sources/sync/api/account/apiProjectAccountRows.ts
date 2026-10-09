import {
    PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema,
    ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowMutationResponseV1Schema,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { ProjectAccountRowsTransport } from '@/sync/engine/projects/projectAccountRowsSync';
import { RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';

/** Credential and Home are captured by the incumbent Account request context. */
export function createApiProjectAccountRowsTransport(options: Readonly<{ request(path: string, init?: RequestInit): Promise<Response> }>): ProjectAccountRowsTransport {
    async function post(operation: 'list' | 'mutate', input: unknown, signal?: AbortSignal): Promise<unknown> {
        signal?.throwIfAborted();
        const response = await options.request(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/${operation}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
        }).catch((error: unknown) => {
            if (operation === 'mutate' && classifyHomeDomainHttpMutationFailureV1({ error, issued: true, aborted: signal?.aborted === true }) === 'outcome_unknown') {
                throw Object.assign(new Error('Project mutation settlement is unknown'), { code: 'outcome_unknown' });
            }
            throw error;
        });
        if (!response.ok) {
            if (response.status === 503) throw new RetryableServerResponseError(response.status, 'Project row storage unavailable');
            throw new Error(`Project row request failed (${response.status})`);
        }
        return await response.json();
    }
    return {
        list: async (options) => ProjectAccountRowListResponseV1Schema.parse(await post('list', {}, options?.signal)),
        mutate: async (input, options) => ProjectAccountRowMutationResponseV1Schema.parse(await post('mutate', ProjectAccountRowMutationRequestV1Schema.parse(input), options?.signal)),
    };
}
