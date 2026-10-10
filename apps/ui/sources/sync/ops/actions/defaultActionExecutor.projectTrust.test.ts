import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { PROJECT_TRUST_ROUTE_V1, ProjectTrustMutationRequestV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';

// Only Home HTTP, device credentials and disconnected sockets are boundaries.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
let serverId: string;
const project = { serverId: 'foreign-project-home', projectId: 'qualified-project' };
const value = { project, reviewedEffectDigest: 'reviewed-effect', approvedAtMs: 17 };
const listPath = `${PROJECT_TRUST_ROUTE_V1}/list`;
const readPath = `${PROJECT_TRUST_ROUTE_V1}/read`;
const mutatePath = `${PROJECT_TRUST_ROUTE_V1}/mutate`;
beforeEach(async () => {
    await homes.reset(); await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Approving Account', serverUrl: 'https://trust-approving.test', accountId: 'approver', active: false });
    await homes.addHome({ name: 'Focused custodian', serverUrl: 'https://trust-custodian.test', accountId: 'custodian' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    homes.answer(serverId, listPath, { body: { rows: [{ project, revision: 4, content: { t: 'plain', v: value } }] } });
    homes.answer(serverId, readPath, { body: { status: 'present', revision: 4, content: { t: 'plain', v: value } } });
    homes.answer(serverId, mutatePath, { select: input => {
        expect(ProjectTrustMutationRequestV1Schema.parse(input)).toEqual({ project, expectedRevision: 4, content: null });
        return { body: { status: 'updated', revision: 5, cursor: 1 } };
    } });
});
afterEach(async () => { await homes.reset(); });

describe('Project Trust through the canonical UI Action policy', () => {
    it('lists the requester Account at its explicit Home, never the qualified Project custodian or focused Account', async () => {
        expect(await createDefaultActionExecutor().execute('projects.trust.list', { project }, {
            serverId, expectedAccountId: 'approver', surface: 'ui',
        })).toEqual({ ok: true, result: { trust: [{ project, revision: 4, value }] } });
        expect(homes.requestsFor(listPath).map(row => ({ serverId: row.serverId, token: row.token, input: row.input })))
            .toEqual([{ serverId, token: createAccountTokenForTests('approver'), input: { project } }]);
    });
    it('honors configurable Ask first and exact reviewed revision/digest before Forget', async () => {
        const input = { project, expectedRevision: 4, expectedEffectDigest: value.reviewedEffectDigest };
        await homes.requireUiApproval(serverId, 'projects.trust.revoke');
        const pending = await createDefaultActionExecutor().execute('projects.trust.revoke', input, {
            serverId, expectedAccountId: 'approver', surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        });
        expect(pending).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'projects.trust.revoke' } });
        expect(homes.requestsFor(mutatePath)).toEqual([]);
    });
    it('does not revoke a reapproved effect and removes only the exact current row when admitted', async () => {
        const executor = createDefaultActionExecutor();
        const context = { serverId, expectedAccountId: 'approver', surface: 'ui', authority: 'present_user' } as const;
        expect(await executor.execute('projects.trust.revoke', { project, expectedRevision: 4, expectedEffectDigest: 'older-effect' }, context))
            .toEqual({ ok: true, result: { project, status: 'conflict' } });
        expect(homes.requestsFor(mutatePath)).toEqual([]);
        expect(await executor.execute('projects.trust.revoke', { project, expectedRevision: 4, expectedEffectDigest: value.reviewedEffectDigest }, context))
            .toEqual({ ok: true, result: { project, status: 'removed' } });
        expect(homes.requestsFor(mutatePath)).toHaveLength(1);
    });
});
