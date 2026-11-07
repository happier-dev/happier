import { afterEach, expect, it } from 'vitest';
import { DeploymentBackupActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
afterEach(async () => { await homes.reset(); });

it('carries requester Account content for an unconfirmed own-Machine backup history read', async () => {
    const serverId = await homes.addHome({ name: 'Backup Home', serverUrl: 'https://backup-action.test',
        serverIdentityId: 'srv_backup_action', accountId: 'owner', currentAccount: true });
    const actionId = 'deployments.backups.history';
    const input = DeploymentBackupActionInputSchemasV1[actionId].parse({ serverId: 'srv_backup_action',
        environmentId: 'environment', expectedRevision: 1, configRevision: 1,
        machineId: 'runtime', installationId: 'installed', targetLinkId: 'target', deploymentId: 'deployment' });
    const history = { kind: 'history', environmentId: input.environmentId, configRevision: 1, history: { entries: [] } };
    const effects: unknown[] = [];
    await answerExternalActionAccountForHome(homes, serverId, { actionId, machineId: 'runtime',
        installationId: 'installed', tokenEpoch: 0, execute: (operand, context) => {
            expect(context.invocation).toMatchObject({ surface: 'ui', caller: { kind: 'host' } });
            effects.push(DeploymentBackupActionInputSchemasV1[actionId].parse(operand));
            return history;
        } });

    const result = await createFrontDoorActionExecute()(actionId, input, {
        surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'owner',
    });

    expect(result).toEqual({ ok: true, result: history });
    expect(effects).toEqual([input]);
    expect(homes.requestsFor(`/v1/actions/${actionId}/execution-authorization`)).toHaveLength(1);
    expect(homes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(1);
});
