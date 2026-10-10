import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
beforeEach(() => { resetScopedHomeActionExecutorsForTests(); });
afterEach(() => standardCleanup());

function provisioner(title: string, location: 'local' | 'cloud'): MachineProvisionersListResultV1['provisioners'][number] {
    return { contribution: { pluginId: 'custom.compute', localId: location }, occurrenceId: `${location}-occurrence`, descriptor: {
        id: location, title, icon: 'server', resourceKind: 'VM', schemaVersion: 1,
        launchSchema: { type: 'object', properties: {}, additionalProperties: false }, resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
        platforms: ['linux'], prerequisites: [], billing: { location, stoppedBilling: location === 'local' ? 'not-billed' : 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
        actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
    } };
}

describe('Machine Defaults installed provisioner names', () => {
    it.each(['creation', 'retention'] as const)('honors the Account settings.set policy when changing %s', async (operation) => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
        const previous = storage.getState();
        const settings = {
            managedMachineCreationEnabled: true,
            machineRetentionDefaultsV1: { v: 1 as const },
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } }),
        };
        const features = createRootLayoutFeaturesResponse();
        const home = await serveActionHomes({ homes: [
            { key: 'build', serverUrl: `https://par-defaults-${operation}.test`, accountId: 'owner', settings },
        ], route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
            ? Response.json(features) : undefined });
        onTestFinished(() => {
            storage.setState({ settings: previous.settings, settingsScope: previous.settingsScope,
                profileScope: previous.profileScope, machineListByServerId: previous.machineListByServerId });
            home.dispose();
        });
        storage.setState({ machineListByServerId: {} });
        await loadSyncSingletonForTests();
        const transport = await import('@/utils/system/runtimeFetch');
        // This HTTP harness supplies Settings responses before its request ledger; observe the
        // genuine transport unchanged so a blocked write cannot disappear from the assertion.
        const fetch = vi.spyOn(transport, 'runtimeFetch');
        onTestFinished(() => fetch.mockRestore());
        const { Modal } = await import('@/modal');
        const alert = vi.spyOn(Modal, 'alert');
        onTestFinished(() => alert.mockRestore());
        const { MachineDefaultsView } = await import('./MachineDefaultsView');
        const screen = await renderScreen(<MachineDefaultsView />);
        await vi.waitFor(() => expect(screen.findByTestId('settings.machineDefaults.creationEnabled.switch')!.props.disabled).not.toBe(true));
        await act(async () => {
            if (operation === 'creation') {
                screen.findByTestId('settings.machineDefaults.creationEnabled.switch')!.props.onValueChange(false);
            } else {
                screen.pressByTestId('settings.machineDefaults.local.header');
            }
        });
        if (operation === 'retention') {
            const field = screen.findAll(node => node.props?.itemTrigger?.title === 'When unused')[0];
            expect(field).toBeTruthy();
            await act(async () => field!.props.onSelect('unused:stop:1800000'));
        }
        expect(storage.getState().settings.managedMachineCreationEnabled).toBe(true);
        expect(storage.getState().settings.machineRetentionDefaultsV1).toEqual({ v: 1 });
        await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('Error', 'action_disabled'));
        expect(storage.getState().settingsScope).toEqual({ serverId: home.homes.build!.id, accountId: 'owner' });
        expect(fetch.mock.calls.filter(([url, init]) => new URL(String(url)).pathname === '/v2/account/settings'
            && init?.body !== undefined)).toEqual([]);
        expect(home.requests.every(request => request.home === 'build' && request.accountId === 'owner')).toBe(true);
        alert.mockRestore();
        await screen.unmount();
    });

    it('aggregates actual installed controllers of only the focused Home without pretending a Home-global catalog', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const previous = storage.getState();
        const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: 'srv_build' } } });
        const home = await serveActionHomes({ homes: [
            { key: 'other', serverUrl: 'https://par-defaults-other.test', accountId: 'other' },
            { key: 'build', serverUrl: 'https://par-defaults-build.test', accountId: 'owner' },
        ], route: request => {
            if (request.home !== 'build') return undefined;
            if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(features);
            if (request.path !== '/v1/actions/machines.provisioners.list') return undefined;
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.body);
            const rows = envelope.target.kind === 'machine' && envelope.target.machineId === 'local-controller'
                ? [provisioner('Local guest', 'local')] : [provisioner('Cloud service', 'cloud')];
            return Response.json({ v: 1, actionId: 'machines.provisioners.list', requestId: envelope.requestId,
                execution: { ok: true, result: { provisioners: rows } } });
        } });
        onTestFinished(() => {
            storage.setState({ settings: previous.settings, settingsScope: previous.settingsScope,
                profileScope: previous.profileScope, machineListByServerId: previous.machineListByServerId });
            home.dispose();
        });
        expect(await getServerFeaturesSnapshot({ serverId: home.homes.build!.id })).toMatchObject({ status: 'ready', serverIdentityId: 'srv_build' });
        const focusedHome = resolveServerProfileScopeIdForIdentifier(home.homes.build!.id);
        const otherHome = resolveServerProfileScopeIdForIdentifier(home.homes.other!.id);
        expect(getActiveServerSnapshot().serverId).toBe(focusedHome);
        storage.setState({ machineListByServerId: {
            [focusedHome]: [createMachineFixture({ id: 'local-controller', installationId: 'local-installation' }), createMachineFixture({ id: 'cloud-controller', installationId: 'cloud-installation' }), createMachineFixture({ id: 'guest-without-installation' })],
            [otherHome]: [createMachineFixture({ id: 'other-controller', installationId: 'other-installation' })],
        } });
        const controllers: readonly ManagedControllerV1[] = [
            { machineId: 'local-controller', installationId: 'local-installation' },
            { machineId: 'cloud-controller', installationId: 'cloud-installation' },
        ];
        const { useManagedProvisioners } = await import('./useManagedProvisioners');
        const catalog = await renderHook(() => useManagedProvisioners(focusedHome, undefined, controllers));
        await vi.waitFor(() => expect(catalog.getCurrent().loading).toBe(false));
        expect(catalog.getCurrent().provisioners.map(row => row.descriptor.title)).toEqual(['Local guest', 'Cloud service']);
        await catalog.unmount();
        const { MachineDefaultsView } = await import('./MachineDefaultsView');
        const screen = await renderScreen(<MachineDefaultsView />);
        await vi.waitFor(() => expect(home.requests.filter(request => request.path === '/v1/actions/machines.provisioners.list').length > 0
            || screen.getTextContent().includes('Until I delete it')).toBe(true));
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Local guest'));
        expect(screen.getTextContent()).toContain('Cloud service');
        expect(home.requests.filter(request => request.path === '/v1/actions/machines.provisioners.list').map(request => request.body)).toEqual(expect.arrayContaining([
            expect.objectContaining({ target: { kind: 'machine', machineId: 'local-controller' }, input: { homeId: 'srv_build', controller: { machineId: 'local-controller', installationId: 'local-installation' } } }),
            expect.objectContaining({ target: { kind: 'machine', machineId: 'cloud-controller' }, input: { homeId: 'srv_build', controller: { machineId: 'cloud-controller', installationId: 'cloud-installation' } } }),
        ]));
        expect(home.requests.filter(request => request.path === '/v1/actions/machines.provisioners.list')
            .every(request => request.home === 'build' && request.accountId === 'owner')).toBe(true);
        expect(home.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        await screen.unmount();
    });
});
