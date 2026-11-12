import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { BrowserExtensionsListResultV1Schema, BrowserExtensionMutationResultV1Schema,
    BROWSER_EXTENSION_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions';
import { bindExternalActionExecutionAuthorizationHttpPathV1,
    ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { StoreUpdatesScreen } = await import('./StoreUpdatesScreen');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
const { ModalProvider } = await import('@/modal');
const { storage } = await import('@/sync/domains/state/storage');
const { StoreMachineScopeContext } = await import('@/components/settings/plugins/model/useStoreMachineScope');

afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); });

async function renderExtensionUpdate(partial = false, selectedMachine = false) {
    const machineId = 'extensions-machine';
    const extensionId = 'a'.repeat(32);
    const scope = await account.restore({ currentAccount: true, serverIdentityId: 'srv_store_updates',
        machines: [createMachineFixture({ id: machineId, activeAt: Date.now(), metadata: {
            ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: [] },
        } }), ...(selectedMachine ? [createMachineFixture({ id: 'other-machine', activeAt: Date.now() })] : [])] });
    const inventory = BrowserExtensionsListResultV1Schema.parse({ status: 'ready', entries: [{ profileId: 'work',
        restartRequired: false, extension: { id: extensionId, name: 'Passwords', version: '1.0', enabled: true,
            source: { kind: 'webStore', extensionId }, directory: '/browser/extensions/passwords',
            permissions: ['storage'], hostPermissions: [],
            upstream: { state: 'update_available', latest: { kind: 'version', version: '2.0' } },
        } }] });
    if (inventory.status !== 'ready') throw new Error('Expected ready extension inventory');
    const extension = inventory.entries[0]!;
    if (partial) {
        inventory.entries = [];
        await act(async () => { storage.setState({ machineListStatusByServerId: Object.fromEntries(
            Object.keys(storage.getState().machineListByServerId).map(serverId => [serverId, 'loading' as const]),
        ) }); });
    }
    const inventoryTargets: string[] = [];
    account.home.answer(scope.serverId, '/v1/actions/browser.extensions.list', { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        if (envelope.target?.kind === 'machine') inventoryTargets.push(envelope.target.machineId);
        return { body: { v: 1, actionId: 'browser.extensions.list', requestId: envelope.requestId,
            execution: { ok: true, result: inventory } } };
    } });
    const screen = await renderScreen(<ModalProvider><PluginSurfaceFocusEligibilityProvider active>
        <StoreMachineScopeContext.Provider value={selectedMachine ? { serverId: 'srv_store_updates', machineId } : undefined}>
            <StoreUpdatesScreen />
        </StoreMachineScopeContext.Provider>
    </PluginSurfaceFocusEligibilityProvider></ModalProvider>);
    const rowId = `store.updates.row.${serverAccountScopedResourceKey(storage.getState().settingsScope!, 'browserExtension', machineId, 'work', extensionId)}`;
    await vi.waitFor(() => expect(screen.findHostByTestId(partial ? 'store.updates.coverage.partial' : rowId)).not.toBeNull());
    return { screen, rowId, scope, machineId, extensionId, inventory, extension, inventoryTargets };
}

it('checks only the selected Store Machine and shows its current installed extension', async () => {
    const { screen, rowId, scope, machineId, extensionId, inventory, inventoryTargets } = await renderExtensionUpdate(false, true);
    const targets: string[] = [];
    account.home.answer(scope.serverId, '/v1/actions/registries.updates.check', { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        if (envelope.target?.kind !== 'machine') throw new Error('Expected a Machine update carrier');
        targets.push(envelope.target.machineId);
        inventory.entries[0]!.extension.upstream = { state: 'current' };
        return { body: { v: 1, actionId: 'registries.updates.check', requestId: envelope.requestId,
            execution: { ok: true, result: { checkedAt: 10, results: [{ kind: 'browserExtension',
                key: JSON.stringify(['work', extensionId]), upstream: { state: 'current' } }] } } } };
    } });
    await screen.pressByTestIdAsync('store.updates.checkNow');
    await vi.waitFor(() => expect(targets.length).toBeGreaterThan(0));
    expect([...new Set(targets)]).toEqual([machineId]);
    expect([...new Set(inventoryTargets)]).toEqual([machineId]);
    await vi.waitFor(() => expect(screen.findHostByTestId(`${rowId}.review`)).toBeNull());
    expect(screen.findHostByTestId(rowId)).not.toBeNull();
});

it('while inventory is still loading, says only that, never "nothing waiting" or a Retry', async () => {
    const { screen } = await renderExtensionUpdate(true);
    expect(screen.findHostByTestId('store.updates.coverage.partial')).not.toBeNull();
    expect(screen.findHostByTestId('store.updates.coverage.partial.retry')).toBeNull();
    expect(screen.findHostByTestId('store.updates.notChecked')).toBeNull();
    expect(screen.findHostByTestId('store.updates.noSources')).toBeNull();
    expect(screen.findHostByTestId('store.updates.upToDate')).toBeNull();
});

it('renders an actionable review for an available extension update without inventing a destination', async () => {
    const { screen, rowId } = await renderExtensionUpdate();
    expect(screen.findHostByTestId(`${rowId}.review`)).not.toBeNull();
});

it.each([true, false])('dispatches the selected version through real Action admission and permission review (accept=%s)', async accepted => {
    const { screen, rowId, scope, machineId, extensionId, inventory } = await renderExtensionUpdate();
    const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    const serverUrl = getServerProfileById(scope.serverId)!.serverUrl;
    const review = { version: '2.0', permissions: ['storage', 'tabs'], hostPermissions: ['https://example.com/*'] };
    const requests: unknown[] = [];
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId: 'srv_store_updates',
        accountId: scope.accountId, machineId, actionId: 'browser.extensions.update', tokenEpoch: 0, requesterInvocation: 'none',
        execute: input => {
            const parsed = BROWSER_EXTENSION_ACTION_INPUT_SCHEMAS['browser.extensions.update'].parse(input);
            requests.push(parsed);
            if (!parsed.reviewedPermissions) return BrowserExtensionMutationResultV1Schema.parse({ status: 'needs_review', review, restartRequired: true });
            if (!parsed.restartConfirmed) return BrowserExtensionMutationResultV1Schema.parse({ status: 'needs_restart_confirmation', profileId: 'work' });
            inventory.entries = [];
            return BrowserExtensionMutationResultV1Schema.parse({ status: 'updated', restartRequired: true,
                entry: { profileId: 'work', restartRequired: true, extension: { ...inventoryExtension, ...review } } });
        },
    });
    const inventoryExtension = inventory.entries[0]!.extension;
    for (const path of [bindExternalActionExecutionAuthorizationHttpPathV1('browser.extensions.update'), '/v1/actions/browser.extensions.update']) {
        account.home.answer(scope.serverId, path, { select: async body => {
            const response = await boundary.handle(new URL(path, serverUrl), { method: 'POST', body: JSON.stringify(body) });
            if (!response) throw new Error('Expected the external Action boundary');
            return { body: await response.json() };
        } });
    }
    expect(requests).toEqual([]);
    await screen.pressByTestIdAsync(accepted ? rowId : `${rowId}.review`);
    await vi.waitFor(() => expect(screen.findHostByTestId('store.browserExtension.review.confirm')).not.toBeNull());
    expect(screen.findAll(node => node.props.testID === 'store.browserExtension.review.facts.version' && node.props.detail === review.version).length).toBeGreaterThan(0);
    expect(screen.findAll(node => node.props.testID === 'store.browserExtension.review.facts.permission.storage' && node.props.title !== 'storage').length).toBeGreaterThan(0);
    expect(requests).toEqual([{ machineId, profileId: 'work', extensionId, expectedVersion: '2.0' }]);
    await act(async () => screen.pressByTestId(accepted ? 'store.browserExtension.review.confirm' : 'store.browserExtension.review.cancel'));
    if (accepted) {
        await vi.waitFor(() => expect(requests).toHaveLength(2));
        expect(requests[1]).toMatchObject({ expectedVersion: '2.0', reviewedPermissions: review });
        await vi.waitFor(() => expect(screen.findHostByTestId('web-modal-confirm')).not.toBeNull());
        await act(async () => screen.pressByTestId('web-modal-confirm'));
        await vi.waitFor(() => expect(screen.findHostByTestId(rowId)).toBeNull());
        expect(requests[2]).toMatchObject({ expectedVersion: '2.0', reviewedPermissions: review, restartConfirmed: true });
    } else {
        expect(requests).toHaveLength(1);
        expect(screen.findHostByTestId(rowId)).not.toBeNull();
    }
});
