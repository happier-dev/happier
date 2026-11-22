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
const { SourceControlUnavailableState } = await import('./SourceControlUnavailableState');
const { SourceControlStaleSnapshotNotice } = await import('./SourceControlStaleSnapshotNotice');
const { ManagedWorkspaceStartOfferedBeside } = await import('@/components/workspaces/reachability/ManagedWorkspaceStoppedState');
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

describe('SourceControlUnavailableState for a stopped attached workspace (remote workspaces lab project-stopped)', () => {
    it('says the workspace is stopped instead of a source-control failure', async () => {
        const screen = await renderScreen(<SourceControlUnavailableState testID="git" errorCode="managed_power_required" onRetry={vi.fn()} />);
        expect(screen.getTextContent()).toContain(t('files.pane.managedStoppedChangesReason'));
        expect(screen.getTextContent()).not.toContain(t('errors.sourceControlUnavailableTitle'));
        expect(screen.findAllByTestId('git-action')).toHaveLength(0);
    });

    it('offers the same Start as Files, says Starting, then reads source control again', async () => {
        const homeId = 'srv_stopped_git';
        const serverId = await home.addHome({ name: 'Compute', serverUrl: 'https://stopped-git.test',
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
        const screen = await renderScreen(<SourceControlUnavailableState testID="git" errorCode="managed_power_required"
            onRetry={retry} workspaceScope={{ serverId, machineId: controller.machineId, rootPath: workspace.rootPath, workspace }} />);
        try {
            await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('managedMachines.actions.start')));
            await screen.pressByTestIdAsync('git-stopped-action');
            await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('files.pane.managedStartingTitle', { workspace: 'api-dev' })));
            expect(home.requestsFor('/v1/actions/machines.managed.power.set')).toHaveLength(1);
            expect(retry).not.toHaveBeenCalled();
            await act(async () => held.resolve());
            await waitForHomeGovernance(() => expect(retry).toHaveBeenCalledOnce());
        } finally {
            held.resolve();
        }
    });

    it('over the changes it kept, says the workspace is stopped with Start instead of a stale refresh (lab project-stopped)', async () => {
        const homeId = 'srv_stopped_git_warm';
        const serverId = await home.addHome({ name: 'Compute', serverUrl: 'https://stopped-git-warm.test',
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
        const accepted = await answerExternalActionAccountForHome(home, serverId, { ...controller,
            actionId: 'machines.managed.power.set', tokenEpoch: 0, requesterInvocation: 'optional',
            execute: async () => ({ kind: 'accepted', managedId: machine.id, intentRevision: 4 }) });
        home.answer(serverId, '/v1/machines', { body: [accepted.machine] });
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' },
            [createManagedControllerMachineFixture({ id: controller.machineId, installationId: controller.installationId })]);
        const scope = { serverId, machineId: controller.machineId, rootPath: workspace.rootPath, workspace };
        const screen = await renderScreen(<>
            <SourceControlStaleSnapshotNotice testID="git-stale" onRetry={vi.fn()}
                error={{ errorCode: 'managed_power_required' }} workspaceScope={scope} />
            {/* The Git pane beside the Code page that already says it with Start: one Start per page. */}
            <ManagedWorkspaceStartOfferedBeside>
                <SourceControlStaleSnapshotNotice testID="git-beside" onRetry={vi.fn()}
                    error={{ errorCode: 'managed_power_required' }} workspaceScope={scope} />
            </ManagedWorkspaceStartOfferedBeside>
        </>);
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('files.pane.managedStoppedTitle', { workspace: 'api-dev' })));
        await waitForHomeGovernance(() => expect(screen.findAllByTestId('git-stale-stopped-action')).not.toHaveLength(0));
        expect(screen.findAllByTestId('git-beside-stopped')).not.toHaveLength(0);
        expect(screen.findAllByTestId('git-beside-stopped-action')).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain(t('files.sourceControlStale.body'));
    });

    it('reads Starting from Home while a submitted wake has not reached running, in every pane and without Start', async () => {
        const homeId = 'srv_starting_git';
        const serverId = await home.addHome({ name: 'Compute', serverUrl: 'https://starting-git.test',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
        const controller = { machineId: 'host', installationId: 'installation' };
        const workspace = { v: 2, kind: 'managed', serverId: homeId, workspaceId: 'project-checkout',
            managedId: 'attached', controller, rootPath: '/home/coder/api' } as const;
        const provider = { pluginId: 'happier.machine.coder', localId: 'coder' };
        const machine = ManagedMachinePublicFullV1Schema.parse({
            id: workspace.managedId, homeId, custodianAccountId: 'owner', controller, allocation: 'bound',
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 4,
            submittedNativeEffect: { intent: 'start', requestId: 'wake', intentRevision: 4 },
            launch: { provider, schemaVersion: 1, name: 'api-dev', choices: { existingWorkspaceId: 'native-id' } },
            resource: { contributionRef: provider, schemaVersion: 1, value: { workspaceId: 'native-id' } },
            workspaceAttachment: { os: 'linux', arch: 'x64', home: '/home/coder' },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'present', observedAt: 1, power: 'stopped' },
        });
        home.answer(serverId, '/v1/machines/managed/actions/get', { body: machine });
        const accepted = await answerExternalActionAccountForHome(home, serverId, { ...controller,
            actionId: 'machines.managed.power.set', tokenEpoch: 0, requesterInvocation: 'optional',
            execute: async () => ({ kind: 'accepted', managedId: machine.id, intentRevision: 5 }) });
        home.answer(serverId, '/v1/machines', { body: [accepted.machine] });
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' },
            [createManagedControllerMachineFixture({ id: controller.machineId, installationId: controller.installationId })]);
        const scope = { serverId, machineId: controller.machineId, rootPath: workspace.rootPath, workspace };
        const screen = await renderScreen(<>
            <SourceControlUnavailableState testID="git" errorCode="managed_power_required" onRetry={vi.fn()} workspaceScope={scope} />
            {/* Over kept changes, a refresh refused while it starts is the workspace starting, not a refresh that fell behind. */}
            <SourceControlStaleSnapshotNotice testID="git-stale" onRetry={vi.fn()} error={{ errorCode: 'BACKEND_UNAVAILABLE' }} workspaceScope={scope} />
        </>);
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('files.pane.managedStartingTitle', { workspace: 'api-dev' })));
        await waitForHomeGovernance(() => expect(screen.findAllByTestId('git-stale-stopped')).not.toHaveLength(0));
        expect(screen.getTextContent()).not.toContain(t('files.sourceControlStale.body'));
        expect(screen.findAllByTestId('git-stopped-action')).toHaveLength(0);
        expect(home.requestsFor('/v1/actions/machines.managed.power.set')).toHaveLength(0);
    });
});
