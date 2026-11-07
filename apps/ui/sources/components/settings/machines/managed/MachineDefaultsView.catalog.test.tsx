import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
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

installSettingsViewCommonModuleMocks({ storage: 'real', text: async () => vi.importActual<typeof import('@/text')>('@/text') });
// Match the sibling Defaults harness: import the real Sync graph during collection,
// before any Account journey's deadline starts. The Home harness also uses this bridge.
await loadSyncSingletonForTests();
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
beforeEach(() => { resetScopedHomeActionExecutorsForTests(); });
afterEach(() => standardCleanup());

function provisioner(title: string, location: 'local' | 'cloud'): MachineProvisionersListResultV1['provisioners'][number] {
    return { contribution: { pluginId: 'custom.compute', localId: location }, occurrenceId: `${location}-occurrence`, acquireExecutionTarget: 'daemon' as const, descriptor: {
        id: location, title, icon: 'server', resourceKind: 'VM', schemaVersion: 1,
        launchSchema: { type: 'object', properties: {}, additionalProperties: false }, resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
        platforms: ['linux'], prerequisites: [], billing: { location, stoppedBilling: location === 'local' ? 'not-billed' : 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
        actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
    } };
}

describe('Machine Defaults declarations and controller-local availability', () => {
    it('settles without commits for unrelated settings and commits a changed creation default once', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const previous = storage.getState();
        const features = createRootLayoutFeaturesResponse();
        const home = await serveActionHomes({ homes: [
            { key: 'defaults', serverUrl: 'https://qap2-defaults.test', accountId: 'owner', currentAccount: true },
        ], route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
            ? Response.json(features) : undefined });
        onTestFinished(async () => {
            storage.setState({ settings: previous.settings, settingsScope: previous.settingsScope,
                profileScope: previous.profileScope, machineListByServerId: previous.machineListByServerId });
            await home.dispose();
        });
        await loadSyncSingletonForTests();
        const { MachineDefaultsView } = await import('./MachineDefaultsView');
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id="defaults" onRender={() => { commits += 1; }}>
            <MachineDefaultsView />
        </React.Profiler>);
        onTestFinished(() => screen.unmount());
        await vi.waitFor(() => expect(screen.findByTestId('settings.machineDefaults.creationEnabled.switch')!.props.disabled).not.toBe(true));
        const initialCommits = commits;
        for (let version = 1; version <= 5; version += 1) {
            await act(async () => storage.getState().applySettings({
                ...storage.getState().settings, analyticsOptOut: version % 2 === 0,
            }, version));
        }
        expect(commits - initialCommits).toBe(0);
        const control = () => screen.findByTestId('settings.machineDefaults.creationEnabled.switch')!;
        const next = !control().props.value;
        await act(async () => storage.getState().applySettings({
            ...storage.getState().settings, managedMachineCreationEnabled: next,
        }, 6));
        expect(control().props.value).toBe(next);
        expect(commits - initialCommits).toBe(1);
    });

    it('persists the deletion reminder lead time through the Account Settings Action, including a custom duration', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const previous = storage.getState();
        const features = createRootLayoutFeaturesResponse();
        const home = await serveActionHomes({ homes: [
            { key: 'reminders', serverUrl: 'https://defaults-reminders.test', accountId: 'owner',
                settings: { managedMachineCreationEnabled: false }, currentAccount: true },
        ], route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
            ? Response.json(features) : undefined });
        onTestFinished(async () => {
            storage.setState({ settings: previous.settings, settingsScope: previous.settingsScope,
                profileScope: previous.profileScope, machineListByServerId: previous.machineListByServerId });
            await home.dispose();
        });
        await loadSyncSingletonForTests();
        const { Modal } = await import('@/modal');
        // The native text-entry sheet is a platform boundary; admission and Settings persistence stay real.
        const prompt = vi.spyOn(Modal, 'prompt').mockResolvedValue('90 min');
        onTestFinished(() => prompt.mockRestore());
        const { MachineDefaultsView } = await import('./MachineDefaultsView');
        const screen = await renderScreen(<MachineDefaultsView />);
        onTestFinished(() => screen.unmount());
        const control = () => screen.findAll(node => node.props.testID === 'settings.machineDefaults.deletionReminderLeadTime.select'
            && typeof node.props.onCustom === 'function')[0]!;
        await vi.waitFor(() => {
            expect(control()).toBeTruthy();
            expect(control().props.disabled).toBe(false);
        });
        expect(control().props.selectedId).toBe('172800000');
        await act(async () => control().props.onSelect('86400000'));
        await vi.waitFor(() => expect(storage.getState().settings.managedMachineDeletionReminderLeadTimeMs).toBe(86400000));
        expect(control().props.selectedId).toBe('86400000');
        await act(async () => control().props.onSelect('0'));
        await vi.waitFor(() => expect(storage.getState().settings.managedMachineDeletionReminderLeadTimeMs).toBe(0));
        expect(control().props.selectedId).toBe('0');
        await act(async () => control().props.onCustom());
        await vi.waitFor(() => expect(storage.getState().settings.managedMachineDeletionReminderLeadTimeMs).toBe(5400000));
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.homes.reminders!.serverUrl);
        const response = await home.fetch(`${home.homes.reminders!.serverUrl}/v2/account/settings`, {
            headers: { Authorization: `Bearer ${credentials!.token}` },
        });
        expect(await response.json()).toMatchObject({ content: { t: 'plain', v: {
            managedMachineDeletionReminderLeadTimeMs: 5400000, managedMachineCreationEnabled: false,
        } } });
    });

    it.each(['creation', 'retention', 'reminder'] as const)('honors the Account settings.set policy when changing %s', async (operation) => {
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
            { key: 'build', serverUrl: `https://par-defaults-${operation}.test`, accountId: 'owner', settings, currentAccount: true },
        ], route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
            ? Response.json(features) : undefined });
        onTestFinished(async () => {
            storage.setState({ settings: previous.settings, settingsScope: previous.settingsScope,
                profileScope: previous.profileScope, machineListByServerId: previous.machineListByServerId });
            await home.dispose();
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
        const { router } = await import('expo-router');
        const push = vi.spyOn(router, 'push');
        onTestFinished(() => push.mockRestore());
        const { MachineDefaultsView } = await import('./MachineDefaultsView');
        const screen = await renderScreen(<MachineDefaultsView />);
        await vi.waitFor(() => expect(screen.findByTestId('settings.machineDefaults.creationEnabled.switch')!.props.disabled).not.toBe(true));
        await act(async () => {
            if (operation === 'creation') {
                screen.findByTestId('settings.machineDefaults.creationEnabled.switch')!.props.onValueChange(false);
            } else if (operation === 'reminder') {
                const control = screen.findAll(node => node.props.testID === 'settings.machineDefaults.deletionReminderLeadTime.select'
                    && typeof node.props.onCustom === 'function')[0]!;
                control.props.onSelect('86400000');
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
        expect(storage.getState().settings.managedMachineDeletionReminderLeadTimeMs).toBe(172800000);
        await vi.waitFor(() => expect(alert).toHaveBeenCalled());
        const buttons = alert.mock.calls.at(-1)![2];
        const openSettings = buttons?.find(button => button.style !== 'cancel');
        expect(openSettings?.onPress).toEqual(expect.any(Function));
        await act(async () => { openSettings!.onPress!(); });
        expect(push).toHaveBeenCalledWith('/settings/actions/settings.set');
        expect(storage.getState().settingsScope).toEqual({ serverId: home.homes.build!.id, accountId: 'owner' });
        expect(fetch.mock.calls.filter(([url, init]) => new URL(String(url)).pathname === '/v2/account/settings'
            && init?.body !== undefined)).toEqual([]);
        expect(home.requests.filter(request => request.home !== 'build'
            // Public feature discovery is intentionally unauthenticated; Account reads and Actions are not.
            || request.path !== '/v1/features' && request.accountId !== 'owner')
            .map(({ home, accountId, path, method }) => ({ home, accountId, path, method }))).toEqual([]);
        alert.mockRestore();
        await screen.unmount();
    });

    it('reads only the selected controller of the focused Home and keeps Defaults independent of installed catalogs', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const previous = storage.getState();
        const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: 'srv_build' } } });
        const home = await serveActionHomes({ homes: [
            { key: 'other', serverUrl: 'https://par-defaults-other.test', accountId: 'other' },
            { key: 'build', serverUrl: 'https://par-defaults-build.test', accountId: 'owner', currentAccount: true },
        ], route: request => {
            if (request.home !== 'build') return undefined;
            if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(features);
            if (request.path !== '/v1/actions/machines.provisioners.list') return undefined;
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.body);
            // A failed refresh must preserve this Account's last successful catalog.
            if (envelope.target?.kind === 'machine' && envelope.target.machineId === 'failing-controller') return Response.json({ error: 'unavailable' }, { status: 503 });
            const rows = envelope.target?.kind === 'machine' && envelope.target.machineId === 'local-controller'
                ? [provisioner('Local guest', 'local')] : [provisioner('Cloud service', 'cloud')];
            return Response.json({ v: 1, actionId: 'machines.provisioners.list', requestId: envelope.requestId,
                execution: { ok: true, result: { provisioners: rows } } });
        } });
        onTestFinished(async () => {
            storage.setState({ settings: previous.settings, settingsScope: previous.settingsScope,
                profileScope: previous.profileScope, machineListByServerId: previous.machineListByServerId });
            await home.dispose();
        });
        expect(await getServerFeaturesSnapshot({ serverId: home.homes.build!.id })).toMatchObject({ status: 'ready', serverIdentityId: 'srv_build' });
        const focusedHome = resolveServerProfileScopeIdForIdentifier(home.homes.build!.id);
        const otherHome = resolveServerProfileScopeIdForIdentifier(home.homes.other!.id);
        expect(getActiveServerSnapshot().serverId).toBe(focusedHome);
        const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
        onTestFinished(clearPluginAccountAvailabilityProjection);
        // This fixture has no Account offers; a missing Account answer is an availability failure.
        replacePluginAccountAvailabilityProjection({ scope: { serverId: focusedHome, accountId: 'owner' },
            snapshot: { availabilityCursor: 1, inventoryComplete: false, intentReads: [], materializations: [], snapshots: [] } });
        storage.setState({ machineListByServerId: {
            [focusedHome]: [createMachineFixture({ id: 'local-controller', installationId: 'local-installation', activeAt: Date.now() }), createMachineFixture({ id: 'cloud-controller', installationId: 'cloud-installation', activeAt: Date.now() }), createMachineFixture({ id: 'guest-without-installation' }),
        // Installed availability is controller-local and remains separate from Defaults declarations.
                createMachineFixture({ id: 'offline-controller', installationId: 'offline-installation', active: false, activeAt: 1 }),
                createMachineFixture({ id: 'failing-controller', installationId: 'failing-installation', activeAt: Date.now() })],
            [otherHome]: [createMachineFixture({ id: 'other-controller', installationId: 'other-installation' })],
        } });
        const controller: ManagedControllerV1 = { machineId: 'local-controller', installationId: 'local-installation' };
        const { useManagedProvisioners } = await import('./useManagedProvisioners');
        const transport = await import('@/utils/system/runtimeFetch');
        const fetch = vi.spyOn(transport, 'runtimeFetch');
        onTestFinished(() => fetch.mockRestore());
        const catalog = await renderHook((selected: ManagedControllerV1) => useManagedProvisioners(focusedHome, undefined, selected),
            { initialProps: controller });
        await vi.waitFor(() => expect(catalog.getCurrent().loading).toBe(false));
        expect(catalog.getCurrent().error).toBeNull();
        expect(catalog.getCurrent().provisioners.map(row => row.descriptor.title)).toEqual(['Local guest']);
        const modeReads = () => fetch.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/account/encryption').length;
        const initialModeReads = modeReads();
        expect(initialModeReads).toBeGreaterThan(0);
        const initialCatalogReads = home.requests.filter(request => request.path === '/v1/actions/machines.provisioners.list').length;
        // Machine presence updates rebuild these objects without changing any catalog demand.
        await catalog.rerender({ ...controller });
        await vi.waitFor(() => expect(catalog.getCurrent().loading).toBe(false));
        expect(modeReads()).toBe(initialModeReads);
        expect(home.requests.filter(request => request.path === '/v1/actions/machines.provisioners.list')).toHaveLength(initialCatalogReads);
        // Explicit refresh still reads the real controller catalog rather than retaining stale data.
        await act(async () => catalog.getCurrent().refresh());
        await vi.waitFor(() => expect(catalog.getCurrent().loading).toBe(false));
        expect(home.requests.filter(request => request.path === '/v1/actions/machines.provisioners.list')).toHaveLength(initialCatalogReads * 2);
        // Changing the selected controller still reads its exact catalog.
        await catalog.rerender({ machineId: 'cloud-controller', installationId: 'cloud-installation' });
        await vi.waitFor(() => expect(catalog.getCurrent().loading).toBe(false));
        expect(home.requests.filter(request => request.path === '/v1/actions/machines.provisioners.list')).toHaveLength(initialCatalogReads * 2 + 1);
        expect(catalog.getCurrent().provisioners.map(row => row.descriptor.title)).toEqual(['Cloud service']);
        await catalog.rerender({ machineId: 'failing-controller', installationId: 'failing-installation' });
        await vi.waitFor(() => expect(catalog.getCurrent().loading).toBe(false));
        expect(catalog.getCurrent().error).toBeTruthy();
        expect(catalog.getCurrent().provisioners.map(row => row.descriptor.title)).toEqual(['Cloud service']);
        const settledCatalogReads = home.requests.filter(request => request.path === '/v1/actions/machines.provisioners.list').length;
        await catalog.unmount();
        const { MachineDefaultsView } = await import('./MachineDefaultsView');
        const screen = await renderScreen(<MachineDefaultsView />);
        expect(screen.getTextContent()).toContain('Lima');
        expect(screen.getTextContent()).toContain('Hetzner');
        expect(home.requests.filter(request => request.path === '/v1/actions/machines.provisioners.list')).toHaveLength(settledCatalogReads);
        expect(home.requests.filter(request => request.path === '/v1/actions/machines.provisioners.list').map(request => request.body)).toEqual(expect.arrayContaining([
            expect.objectContaining({ target: { kind: 'machine', machineId: 'local-controller' }, input: { homeId: 'srv_build', controller: { machineId: 'local-controller', installationId: 'local-installation' } } }),
            expect.objectContaining({ target: { kind: 'machine', machineId: 'cloud-controller' }, input: { homeId: 'srv_build', controller: { machineId: 'cloud-controller', installationId: 'cloud-installation' } } }),
        ]));
        expect(home.requests.filter(request => request.path === '/v1/actions/machines.provisioners.list')
            .every(request => request.home === 'build' && request.accountId === 'owner')).toBe(true);
        expect(home.requests.some(request => request.path === '/v1/actions/machines.provisioners.list'
            && JSON.stringify(request.body).includes('offline-controller'))).toBe(false);
        expect(home.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        await screen.unmount();
    });

    it('shows declared names without demanding any controller catalog, including silent online controllers', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const previous = storage.getState();
        const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: 'srv_slow' } } });
        // A controller marked online whose catalog read has not come back (live: stale presence on a busy Home).
        const silent = new Promise<Response>(() => {});
        const home = await serveActionHomes({ homes: [
            { key: 'build', serverUrl: 'https://par-defaults-slow.test', accountId: 'owner', currentAccount: true },
        ], route: request => {
            if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(features);
            if (request.path !== '/v1/actions/machines.provisioners.list') return undefined;
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.body);
            if (envelope.target?.kind === 'machine' && envelope.target.machineId === 'silent-controller') return silent;
            return Response.json({ v: 1, actionId: 'machines.provisioners.list', requestId: envelope.requestId,
                execution: { ok: true, result: { provisioners: [provisioner('Local guest', 'local')] } } });
        } });
        onTestFinished(async () => {
            storage.setState({ settings: previous.settings, settingsScope: previous.settingsScope,
                profileScope: previous.profileScope, machineListByServerId: previous.machineListByServerId });
            await home.dispose();
        });
        expect(await getServerFeaturesSnapshot({ serverId: home.homes.build!.id })).toMatchObject({ status: 'ready' });
        const focusedHome = resolveServerProfileScopeIdForIdentifier(home.homes.build!.id);
        storage.setState({ machineListByServerId: { [focusedHome]: [
            createMachineFixture({ id: 'silent-controller', installationId: 'silent-installation', activeAt: Date.now() }),
            createMachineFixture({ id: 'local-controller', installationId: 'local-installation', activeAt: Date.now() }),
        ] } });
        const { MachineDefaultsView } = await import('./MachineDefaultsView');
        const screen = await renderScreen(<MachineDefaultsView />);
        expect(screen.getTextContent()).toContain('Lima');
        expect(home.requests.filter(request => request.path === '/v1/actions/machines.provisioners.list')).toEqual([]);
        await screen.unmount();
    });
});
