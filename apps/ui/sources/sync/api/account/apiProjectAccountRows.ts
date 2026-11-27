import {
    PROJECT_ACCOUNT_ROWS_ROUTE_V1, PROJECT_ACCOUNT_ROW_CENSUS_LIST_KINDS_V1, ProjectAccountRowListResponseV1Schema,
    ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowMutationResponseV1Schema,
    ProjectAccountRowReadRequestV1Schema, ProjectAccountRowReadResponseV1Schema, buildProjectAccountRowPhysicalKeyV1,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { ProjectAccountRowsTransport } from '@/sync/engine/projects/projectAccountRowsSync';
import { RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import type { ServerFetch } from '@/sync/http/client';

/** Credential and Home are captured by the incumbent Account request context. */
export function createApiProjectAccountRowsTransport(options: Readonly<{ request: ServerFetch }>): ProjectAccountRowsTransport {
    // Project navigation includes pinned services and authoring ids; defaults bodies are selected exact reads.
    // An older server refuses it as invalid params; this Home then lists its older default census.
    let includeAuthoringSession = true;
    async function post(operation: 'list' | 'read' | 'mutate', input: unknown, signal?: AbortSignal): Promise<Response> {
        signal?.throwIfAborted();
        const response = await options.request(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/${operation}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
        }, { recoveryRead: operation === 'mutate' ? false : 'unbounded' }).catch((error: unknown) => {
            if (operation === 'mutate' && classifyHomeDomainHttpMutationFailureV1({ error, issued: true, aborted: signal?.aborted === true }) === 'outcome_unknown') {
                throw Object.assign(new Error('Project mutation settlement is unknown'), { code: 'outcome_unknown' });
            }
            throw error;
        });
        return response;
    }
    function assertOk(response: Response): void {
        if (!response.ok) {
            if (response.status === 503) throw new RetryableServerResponseError(response.status, 'Project row storage unavailable');
            throw new Error(`Project row request failed (${response.status})`);
        }
    }
    async function isInvalidListShape(response: Response): Promise<boolean> {
        if (response.status !== 400) return false;
        const error: unknown = await response.json().catch(() => null);
        return Boolean(error && typeof error === 'object' && 'error' in error && error.error === 'invalid-params');
    }
    async function postJson(operation: 'read' | 'mutate', input: unknown, signal?: AbortSignal): Promise<unknown> {
        const response = await post(operation, input, signal);
        assertOk(response);
        return response.json();
    }
    return {
        read: async (key, options) => {
            const result = ProjectAccountRowReadResponseV1Schema.parse(await postJson('read',
                ProjectAccountRowReadRequestV1Schema.parse({ key, ...(includeAuthoringSession ? { includeAuthoringSession: true } : {}) }), options?.signal));
            if (result.status === 'present' && buildProjectAccountRowPhysicalKeyV1(result.row.key) !== buildProjectAccountRowPhysicalKeyV1(key)) {
                throw new Error('Project row identity mismatch');
            }
            return result;
        },
        list: async (options) => {
            const selection = includeAuthoringSession
                ? { kinds: [...PROJECT_ACCOUNT_ROW_CENSUS_LIST_KINDS_V1], includeAuthoringSession: true } : {};
            const validator = options?.validator;
            const signal = options?.signal;
            let response = await post('list', { ...selection, ...(validator ? { validator } : {}) }, signal);
            if (validator && response.status === 204) return { status: 'not-modified' };
            let invalidShape = await isInvalidListShape(response);
            if (validator && invalidShape) {
                // An older Home can reject the optional field after a rollback.
                response = await post('list', selection, signal);
                invalidShape = await isInvalidListShape(response);
            }
            if (includeAuthoringSession && invalidShape) {
                includeAuthoringSession = false;
                response = await post('list', {}, signal);
            }
            assertOk(response);
            const result = ProjectAccountRowListResponseV1Schema.parse(await response.json());
            const nextValidator = response.headers.get('ETag');
            return result.status === 'listed' && nextValidator ? { ...result, validator: nextValidator } : result;
        },
        mutate: async (input, options) => ProjectAccountRowMutationResponseV1Schema.parse(await postJson('mutate', ProjectAccountRowMutationRequestV1Schema.parse(input), options?.signal)),
    };
}
