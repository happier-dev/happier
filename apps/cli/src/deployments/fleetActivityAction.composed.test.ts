import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';

afterEach(() => vi.restoreAllMocks());

it('reads a typed Fleet Activity page under the invoking Account through the CLI Action executor', async () => {
    const serverId = 'fleet-home';
    const serverHttpBaseUrl = 'https://fleet-action.test';
    const accountId = 'requester';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const environment = createDeploymentEnvironmentHeaderV1({ serverId });
    const receipt = createDeploymentReceiptHeaderV1({ id: 'receipt', environmentId: environment.id, contentArtifactId: null });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        expect(request.headers?.Authorization).toBe(`Bearer ${token}`);
        const path = new URL(String(request.url)).pathname;
        if (path === '/v1/deployments/environments') {
            return { status: 200, data: { ok: true, items: [environment], nextCursor: null } };
        }
        if (path === `/v1/deployments/environments/${environment.id}/deployments`) {
            return { status: 200, data: { ok: true, items: [receipt], nextCursor: null } };
        }
        throw new Error(`Unexpected Fleet Activity request: ${path}`);
    });
    const { executor } = createCliActionExecutorHarness({ token, credentials, serverId, serverHttpBaseUrl,
        sessionId: '', mode: 'plain', ctx: null, isCredentialCurrent: async () => true });
    const result = await executor.execute('machines.activity.list', { serverId, kind: 'receipt', limit: 1 }, {
        surface: 'cli', authority: 'present_user', serverId, runtimeAccountId: accountId,
    });
    expect(result).toMatchObject({ ok: true, result: { items: [{ kind: 'receipt', receipt: { id: receipt.id } }],
        nextCursor: null, coverage: 'complete', unavailableSources: [] } });
});
