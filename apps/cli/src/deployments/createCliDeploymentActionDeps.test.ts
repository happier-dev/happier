import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createCliDeploymentActionDeps } from './createCliDeploymentActionDeps';

afterEach(() => { vi.restoreAllMocks(); });

it.each(['response', 'rejection'] as const)('classifies HTTP 431 %s as a transport refusal before parsing deployment output', async kind => {
    const request = vi.spyOn(axios, 'request');
    if (kind === 'response') request.mockResolvedValue({ status: 431, data: { statusCode: 431, error: 'Request Header Fields Too Large' } });
    else request.mockRejectedValue(Object.assign(new Error('never-record-response-value'), {
        response: { status: 431 }, config: { headers: { authorization: 'never-record-header-value' } },
    }));
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: async () => ({}), async dispatchReceipt() { throw new Error('Read cannot dispatch'); } });
    const result = await deps.deploymentAction!('deployments.receipts.get',
        { serverId: 'home', environmentId: 'environment', deploymentId: 'receipt' }, {});
    expect(result).toMatchObject({ ok: false, errorCode: 'request_headers_too_large', details: { httpStatus: 431 } });
    expect(JSON.stringify(result)).not.toContain('never-record');
});
