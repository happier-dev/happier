import { it, expect } from 'vitest';
import { readWorkflowSessionStartupError } from './workflowSessionStartupFailure';
it('CC3 retains provider catalog Action cause in startup refusal', () => {
 const failureCause = { phase: 'providers.catalog', errorClass: 'Error', errorCode: 'ECONNREFUSED', httpStatus: null } as const;
 const result = readWorkflowSessionStartupError({ version: 1, operationId: 'op', revision: 1, actionId: 'session.spawn_new', state: 'failed', scope: { accountId: 'a', machineId: 'm' }, title: 'Spawn', createdAt: 1, settledAt: 2, cancellation: 'supported', result: { type: 'error', code: 'spawn_failed', retryable: true, providerError: { v: 1, code: 'provider_catalog_unavailable', action: 'retry', retryable: true, failureCause } } });
 expect(result).toMatchObject({ runtimeIssueV1: { failureCause: { providerErrorCode: 'ECONNREFUSED' } }, failureCause });
});
