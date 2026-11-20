import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';
import { ManagedMachinePublicFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createManagedControllerMachineFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { RepositoryTreeRootErrorState } = await import('./RepositoryTreeRootErrorState');
const { t } = await import('@/text');
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
await import('@/sync/ops/actions/defaultActionExecutor');

beforeEach(async () => {
    await home.reset();
    resetScopedHomeActionExecutorsForTests();
    await home.addHome({ name: 'Folder errors', serverUrl: 'https://folder-errors.example.test',
        serverIdentityId: 'folder-errors', accountId: 'account-a' });
});

afterEach(async () => {
    standardCleanup();
    await home.reset();
});

describe('RepositoryTreeRootErrorState recovery', () => {
    it('shows the isolation reason without a retry that cannot fix it', async () => {
        const screen = await renderScreen(<RepositoryTreeRootErrorState error="agent_isolation_unavailable" onRetry={vi.fn()} />);
        expect(screen.getTextContent()).toContain(t('errors.agentIsolationUnavailable'));
        expect(screen.findAllByTestId('repository-tree-root-error-action')).toHaveLength(0);
    });

    it('keeps retry available for a transient timeout', async () => {
        const retry = vi.fn();
        const screen = await renderScreen(<RepositoryTreeRootErrorState error="MACHINE_RPC_TIMEOUT" onRetry={retry} />);
        expect(screen.getTextContent()).toContain(t('errors.connectionTimeout'));
        await screen.pressByTestIdAsync('repository-tree-root-error-action');
        expect(retry).toHaveBeenCalledOnce();
    });
});

describe('RepositoryTreeRootErrorState for a stopped attached workspace (remote workspaces lab project-stoppedCold)', () => {
    it('says the workspace is stopped instead of a listing failure, with no retry that cannot start it', async () => {
        const screen = await renderScreen(<RepositoryTreeRootErrorState error="managed_power_required" machineName="api-dev" onRetry={vi.fn()} />);
        expect(screen.getTextContent()).toContain(t('files.pane.managedStoppedTitle', { workspace: 'api-dev' }));
        expect(screen.getTextContent()).toContain(t('files.pane.managedStoppedReason'));
        expect(screen.findAllByTestId('repository-tree-root-error-action')).toHaveLength(0);
    });

    it('starts the workspace through its managed owner, says Starting, then reads the folder again', async () => {
        const homeId = 'srv_stopped_files';
        const serverId = await home.addHome({ name: 'Compute', serverUrl: 'https://stopped-files.test',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
        const controller = { machineId: 'host', installationId: 'installation' };
        const workspace = { v: 2, kind: 'managed', serverId: homeId, workspaceId: 'project-checkout',
            managedId: 'attached', controller, rootPath: '/home/coder/api' } as const;
        const provider = { pluginId: 'happier.machine.coder', localId: 'coder' };
        const machine = ManagedMachinePublicFullV1Schema.parse({
            id: workspace.managedId, homeId, custodianAccountId: 'owner', controller, allocation: 'bound',
            creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 3,
            launch: { provider, schemaVersion: 1, name: 'api-dev', choices: { existingWorkspaceId: 'native-id' } },
            resource: { contributionRef: provider, schemaVersion: 1, value: { workspaceId: 'native-id' } },
            workspaceAttachment: { os: 'linux', arch: 'x64', home: '/home/coder' },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'present', observedAt: 1, power: 'stopped' },
        });
        home.answer(serverId, '/v1/machines/managed/actions/get', { body: machine });
        const held = createDeferred<void>();
        const accepted = await answerExternalActionAccountForHome(home, serverId, { ...controller,
            actionId: 'machines.managed.power.set', tokenEpoch: 0, requesterInvocation: 'optional', execute: async () => {
                await held.promise;
                return { kind: 'accepted', managedId: machine.id, intentRevision: 4 };
            } });
        home.answer(serverId, '/v1/machines', { body: [accepted.machine] });
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' },
            [createManagedControllerMachineFixture({ id: controller.machineId, installationId: controller.installationId })]);
        const retry = vi.fn();
        const screen = await renderScreen(<RepositoryTreeRootErrorState error="managed_power_required" machineName="api-dev"
            onRetry={retry} workspaceScope={{ serverId, machineId: controller.machineId, rootPath: workspace.rootPath, workspace }} />);
        try {
            await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('managedMachines.actions.start')));
            await screen.pressByTestIdAsync('repository-tree-root-error-action');
            await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('files.pane.managedStartingTitle', { workspace: 'api-dev' })));
            expect(home.requestsFor('/v1/actions/machines.managed.power.set')).toHaveLength(1);
            expect(retry).not.toHaveBeenCalled();
            await act(async () => held.resolve());
            await waitForHomeGovernance(() => expect(retry).toHaveBeenCalledOnce());
        } finally {
            held.resolve();
        }
    });
});
