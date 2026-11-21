import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { PERSONAL_HOME_CREATE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machineConnectionActionIdsV1';
import { REMOTE_HOST_ROWS_ROUTE_V1, RemoteHostCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { act, renderScreen } from '@/dev/testkit';
import { ServerHomePane } from '@/components/homes/add/ServerHomePane';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerProfileScopeIdForIdentifier, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createSystemTaskRunner } from '@/components/systemTasks/createSystemTaskRunner';
import type { SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import { PersonalHomeBootstrapAdmission } from './PersonalHomeBootstrapAdmission';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();

function BootstrapView({ requested }: { requested: boolean }) {
    return <div data-testid={requested ? 'local-setup' : 'automatic-setup'} />;
}

describe('Personal Home creation on the answering desktop', () => {
    let serverId: string;

    beforeEach(async () => {
        await homes.reset();
        vi.stubGlobal('isTauri', true);
        serverId = await homes.addHome({ name: 'Existing Home', serverUrl: 'https://existing.example.test', accountId: 'owner', currentAccount: true });
        await setActiveServerId(serverId, { scope: 'device' });
        storage.getState().activateProfileScope({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        await homes.reset();
    });

    it('routes the signed-in Add Home button through Action policy before opening local setup', async () => {
        const actionId = PERSONAL_HOME_CREATE_ACTION_ID_V1;
        await homes.setActionPolicy(serverId, actionId, 'ui', 'off');
        const screen = await renderScreen(
            <PersonalHomeBootstrapAdmission admission="offer" runtime={BootstrapView}>
                <ServerHomePane testID="add-home" onHomeReady={() => {}} />
            </PersonalHomeBootstrapAdmission>,
        );
        await screen.pressByTestIdAsync('add-home.primary');
        expect(screen.findByTestId('local-setup')).toBeNull();

        await homes.setActionPolicy(serverId, actionId, 'ui', 'allowed');
        await screen.pressByTestIdAsync('add-home.primary');
        expect(screen.findByTestId('local-setup')).not.toBeNull();
    });

    it('enters the mounted bootstrap through its permitted local request', async () => {
        const screen = await renderScreen(<PersonalHomeBootstrapAdmission admission="off" runtime={BootstrapView}>{null}</PersonalHomeBootstrapAdmission>);
        await homes.requireUiApproval(serverId, PERSONAL_HOME_CREATE_ACTION_ID_V1);
        const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
        const executor = createDefaultActionExecutor({ presentUserActionConfirmation: confirm });
        const actionId = PERSONAL_HOME_CREATE_ACTION_ID_V1;
        const context = { surface: 'ui', authority: 'present_user', serverId } as const;
        const input = { method: 'this_computer' };
        await expect(executor.execute(actionId, input, context)).resolves.toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(screen.findByTestId('local-setup')).toBeNull();

        await screen.update(<PersonalHomeBootstrapAdmission admission="offer" runtime={BootstrapView}>{null}</PersonalHomeBootstrapAdmission>);
        await act(async () => {
            await expect(executor.execute(actionId, input, context)).resolves.toMatchObject({ ok: true, result: { status: 'setup_started' } });
        });
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('local-setup')).not.toBeNull();
    });

    it.each([
        { name: 'entered host with a password prompt', input: { method: 'ssh', host: 'box', username: 'owner', port: 2222, authMode: 'password' },
            ssh: { target: 'owner@box', port: 2222, auth: 'password' } },
        { name: 'saved host with its configured authentication', input: { method: 'ssh', savedHostId: 'saved-box', expectedHostRevision: 1 },
            ssh: { target: 'owner@saved-box', port: 2223, auth: 'agent' } },
    ] as const)('runs the personal Home SSH installer from $name', async ({ input, ssh }) => {
        const features = createRootLayoutFeaturesResponse({ features: { remoteHosts: { management: { enabled: true } } } });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, REMOTE_HOST_ROWS_ROUTE_V1, { body: RemoteHostCatalogRowReadResponseV1Schema.parse({
            status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, hosts: [{
                id: 'saved-box', name: 'Saved box', createdAt: 1, updatedAt: 1, lastUsedAt: null,
                ssh: { target: 'owner@saved-box', port: 2223, authMode: 'agent' },
            }] } },
        }) });
        await homes.requireUiApproval(serverId, PERSONAL_HOME_CREATE_ACTION_ID_V1);
        const starts: SystemTaskSpec[] = [];
        const runner = createSystemTaskRunner({ mode: 'tauri', bridge: {
            start: async spec => { starts.push(spec); return 'personal-home'; },
            subscribe: async () => () => {},
            cancel: async () => {}, respond: async () => {},
        } });
        const confirm = vi.fn().mockImplementation(async () => {
            expect(starts).toHaveLength(0);
            return true;
        });
        const executor = createDefaultActionExecutor({ presentUserActionConfirmation: confirm, homeRuntimeRunner: runner });
        const context = { surface: 'ui', authority: 'present_user', serverId } as const;
        await expect(executor.execute(PERSONAL_HOME_CREATE_ACTION_ID_V1, input, context)).resolves.toMatchObject({
            ok: true, result: { status: 'task_started', taskId: 'personal-home' },
        });
        expect(confirm).toHaveBeenCalledOnce();
        expect(starts).toEqual([expect.objectContaining({ kind: 'remote.ssh.manageHost.v1', params: expect.objectContaining({
            action: 'personalHome.create', ssh, pairDevice: true, enrollInvokingClient: true,
        }) })]);
    });
});
