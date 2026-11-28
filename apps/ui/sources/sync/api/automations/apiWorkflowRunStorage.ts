import { isWorkflowRunExecutorStorageOperationV1 } from '@happier-dev/protocol/workflows/workflowRunStorageV1';
import { AutomationRunPreExecutionFailureV1Schema } from '@happier-dev/protocol/automations/automationRunFailureDetailStoredContent';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ServerFetch } from '@/sync/http/client';
import { AutomationApiError, getAutomationAuthHeaders, readAutomationJsonOrThrow } from './apiAutomationHttp';
import type { CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';

const storageReads = createScopedResolutionSingleFlight<unknown>();
// Admission and private opening remain at the Action owner. These operations
// acquire observations; acknowledgements, controls and review writes never share.
const READ_OPERATIONS = new Set(['get', 'list', 'summaries', 'invocations.list', 'invocations.get', 'invocations.current', 'run-key.census']);
const UNSHARED_OBSERVATIONS = new Set(['wait', 'delivery.pull']);

async function readWorkflowStorageJsonOrThrow(response: Response): Promise<unknown> {
    if (response.status === 422) {
        const data: unknown = await response.clone().json().catch(() => null);
        if (data && typeof data === 'object' && 'error' in data && data.error === 'target_unavailable'
            && 'preExecutionFailure' in data && AutomationRunPreExecutionFailureV1Schema.safeParse(data.preExecutionFailure).success) {
            throw Object.assign(new AutomationApiError({ code: data.error, status: response.status }),
                { response: { status: response.status, data } });
        }
    }
    return readAutomationJsonOrThrow(response);
}

/** Account storage carries opaque content and durable intent, never worker publication. */
export function createWorkflowRunAccountStorage(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    request: ServerFetch;
    assertCurrent: () => void;
    readTransport?: CapturedServerReadTransport;
    accountLifetime?: ServerAccountScopeLifetime;
}>) {
    const storage = {
        execute: async (operation: Readonly<Record<string, unknown>>, options?: Readonly<{ signal?: AbortSignal; publisherMachineId?: string; onTransportIssued?: () => void }>): Promise<unknown> => {
            params.assertCurrent();
            if (isWorkflowRunExecutorStorageOperationV1(operation.operation)
                || Object.hasOwn(operation, 'publisherMachineId')
                || options?.publisherMachineId !== undefined) {
                throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
            }
            throwIfAborted(options?.signal);
            const path = '/v3/automations/runs/workflow-storage';
            const operationName = typeof operation.operation === 'string' ? operation.operation : '';
            const read = READ_OPERATIONS.has(operationName);
            if (read && params.readTransport) {
                const transport = params.readTransport;
                const bindingKey = transport.key;
                const scope = transport.scope ?? bindingKey;
                const abort = new AbortController();
                const retirement = params.accountLifetime?.onRetire(() => abort.abort());
                const cancellation = mergeAbortSignals([options?.signal, abort.signal]);
                try {
                    const result = await storageReads.run(JSON.stringify([bindingKey, createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(operation))]),
                        signal => transport.read(path, { method: 'POST',
                            headers: getAutomationAuthHeaders(params.credentials, { includeJsonContentType: true }),
                            body: JSON.stringify(operation), signal }, { includeAuth: false }, readWorkflowStorageJsonOrThrow),
                        { scope, signal: cancellation.signal,
                            fresh: operationName === 'invocations.current' || operationName === 'run-key.census' });
                    params.assertCurrent();
                    return result;
                } finally { cancellation.dispose(); retirement?.dispose(); }
            }
            const mutation = !read && !UNSHARED_OBSERVATIONS.has(operationName);
            const invalidate = () => { if (mutation && params.readTransport) storageReads.invalidate(params.readTransport.scope ?? params.readTransport.key); };
            invalidate();
            try {
                const response = await params.request(path, {
                    method: 'POST',
                    headers: getAutomationAuthHeaders(params.credentials, { includeJsonContentType: true }),
                    body: JSON.stringify(operation),
                    ...(options?.signal ? { signal: options.signal } : {}),
                }, { includeAuth: false,
                    recoveryRead: read || UNSHARED_OBSERVATIONS.has(operationName) ? 'unbounded' : false,
                    ...(operation.operation === 'delete' && options?.onTransportIssued ? { onIssued: options.onTransportIssued } : {}),
                });
                const result = await readWorkflowStorageJsonOrThrow(response);
                params.assertCurrent();
                return result;
            } finally { invalidate(); }
        },
    };
    return {
        execute: async (...[operation, options]: Parameters<typeof storage.execute>) => {
            try {
                return await storage.execute(operation, options);
            } catch (error) {
                if (operation.operation !== 'invocations.list' || operation.knownProgressRevisions === undefined
                    || !(error instanceof AutomationApiError) || error.status !== 400 || error.code !== 'invalid-params') throw error;
                // An older Home can read the same window with its original projection.
                const { knownProgressRevisions: _known, ...legacy } = operation;
                return storage.execute(legacy, options);
            }
        },
    };
}
