import { expect, it } from 'vitest';

import { initializeServerIdentityCache } from '@/app/serverIdentity/serverIdentity';
import { startWorkflowApprovedOperationServer } from './workflowApprovedOperationServer.testkit';

it('retains one process Home identity across isolated Workflow server fixtures', async () => {
    const accountIds: string[] = [];
    for (const _iteration of [0, 1]) {
        const server = await startWorkflowApprovedOperationServer();
        try {
            // Production startup and signed Action admission retain the Home
            // identity for the process, beyond each isolated fixture database.
            await initializeServerIdentityCache();
            const response = await fetch(`${server.baseUrl}/v1/features/authenticated`, {
                headers: { Authorization: `Bearer ${server.token}` },
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ capabilities: {
                serverIdentity: { serverIdentityId: server.homeId },
            } });
            accountIds.push(server.accountId);
        } finally {
            await server.close();
        }
    }
    expect(new Set(accountIds).size).toBe(2);
});
