import {
    PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema,
    ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowMutationResponseV1Schema,
    ProjectAccountRowReadRequestV1Schema, ProjectAccountRowReadResponseV1Schema, buildProjectAccountRowPhysicalKeyV1,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { ProjectAccountRowsTransport } from '@/sync/engine/projects/projectAccountRowsSync';
import { RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import type { ServerFetch } from '@/sync/http/client';

/** Credential and Home are captured by the incumbent Account request context. */
export function createApiProjectAccountRowsTransport(options: Readonly<{ request: ServerFetch }>): ProjectAccountRowsTransport {
    let includeAuthoringSession = true;
    async function post(operation: 'list' | 'read' | 'mutate', input: unknown, signal?: AbortSignal): Promise<unknown> {
        signal?.throwIfAborted();
        const response = await options.request(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/${operation}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
        }, { recoveryRead: operation === 'mutate' ? false : 'unbounded' }).catch((error: unknown) => {
            if (operation === 'mutate' && classifyHomeDomainHttpMutationFailureV1({ error, issued: true, aborted: signal?.aborted === true }) === 'outcome_unknown') {
                throw Object.assign(new Error('Project mutation settlement is unknown'), { code: 'outcome_unknown' });
            }
            throw error;
        });
        if (operation === 'list' && includeAuthoringSession && response.status === 400) {
            const error: unknown = await response.clone().json().catch(() => null);
            if (error && typeof error === 'object' && 'error' in error && error.error === 'invalid-params') {
                includeAuthoringSession = false;
                return await post('list', {}, signal);
            }
        }
        if (!response.ok) {
            if (response.status === 503) throw new RetryableServerResponseError(response.status, 'Project row storage unavailable');
            throw new Error(`Project row request failed (${response.status})`);
        }
        return await response.json();
    }
    return {
        read: async (key, options) => {
            const result = ProjectAccountRowReadResponseV1Schema.parse(await post('read',
                ProjectAccountRowReadRequestV1Schema.parse({ key, ...(includeAuthoringSession ? { includeAuthoringSession: true } : {}) }), options?.signal));
            if (result.status === 'present' && buildProjectAccountRowPhysicalKeyV1(result.row.key) !== buildProjectAccountRowPhysicalKeyV1(key)) {
                throw new Error('Project row identity mismatch');
            }
            return result;
        },
        list: async (options) => ProjectAccountRowListResponseV1Schema.parse(await post('list', includeAuthoringSession ? { includeAuthoringSession: true } : {}, options?.signal)),
        mutate: async (input, options) => ProjectAccountRowMutationResponseV1Schema.parse(await post('mutate', ProjectAccountRowMutationRequestV1Schema.parse(input), options?.signal)),
    };
}
