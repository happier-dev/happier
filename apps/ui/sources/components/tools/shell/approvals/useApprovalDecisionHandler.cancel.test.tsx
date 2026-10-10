import { beforeEach, describe, expect, it } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createUiApprovalRequest } from '@/dev/testkit/harness/approvalInbox';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { useApprovalDecisionHandler } = await import('./useApprovalDecisionHandler');

describe('built-in approval withdrawal through the canonical decision owner', () => {
    beforeEach(async () => { standardCleanup(); await harness.reset(); });
    it('cancels a real pending Machine open without running the physical effect', async () => {
        const serverId = await harness.addHome({ name: 'Terminal Home', serverUrl: 'https://terminal-cancel.test', accountId: 'bob' });
        await harness.requireUiApproval(serverId, 'machines.terminal.open');
        const artifactId = await createUiApprovalRequest({ serverId, actionId: 'machines.terminal.open',
            actionInput: { serverId, machineId: 'machine', terminalKey: 'owned-member', cwd: '/accepted' }, actionRequestId: 'open-own-member' });
        const context = await captureActionAccountContext(serverId);
        try {
            const artifact = await context.fetchArtifact(artifactId);
            if (!artifact || typeof artifact.body !== 'string') throw new Error('Expected actual pending Artifact');
            const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body);
            if (parsed?.family !== 'built_in') throw new Error('Expected built-in approval');
            const hook = await renderHook(() => useApprovalDecisionHandler(artifact, parsed.request, '', serverId));
            expect(await hook.getCurrent()('cancel')).toBe(true);
            const canceled = harness.artifacts(serverId).readPlainBody(artifactId);
            expect(canceled && JSON.parse(canceled)).toMatchObject({ status: 'canceled' });
            expect(canceled && JSON.parse(canceled)).not.toHaveProperty('decision');
            expect(harness.requests.filter(request => request.path.includes('/rpc'))).toEqual([]);
            await hook.unmount();
        } finally { context.dispose(); }
    });
});
