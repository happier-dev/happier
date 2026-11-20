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
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ThemeProfileArtifactHeaderSchema } from '@happier-dev/protocol/account/settings/themeProfileArtifact';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { createArtifactListHttpResponse, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';

vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { StoreUpdatesScreen } = await import('./StoreUpdatesScreen');
const { StoreUpdateRow } = await import('./StoreUpdateRow');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
const { ModalProvider } = await import('@/modal');
const { storage } = await import('@/sync/domains/state/storage');
const { StoreMachineScopeContext } = await import('@/components/settings/plugins/model/useStoreMachineScope');

afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); });

it('windows theme updates in the existing page while retaining version and review navigation', async () => {
    const home = await account.restore({ currentAccount: true, serverIdentityId: 'srv_store_theme_updates',
        machines: [createMachineFixture({ id: 'updates-machine', activeAt: Date.now(), metadata: {
            ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: [] },
        } })] });
    const scope = storage.getState().settingsScope!;
    const rows: Extract<DecryptedArtifact, { isDecrypted: true }>[] = Array.from({ length: 200 }, (_, index) => ({
        id: `update-theme-${index}`, sourceServerId: scope.serverId, ownerAccountId: scope.accountId, access: 'owner',
        isDecrypted: true, title: `Theme ${index}`, headerVersion: 1, bodyVersion: 1, seq: index, createdAt: 0, updatedAt: 0,
        rawHeader: ThemeProfileArtifactHeaderSchema.parse({ v: 1, kind: 'theme_profile.v1', title: `Theme ${index}`,
            mode: 'dark', themeSource: { kind: 'store', contributionId: 'dark', provenance: { sourceId: 'builtin:open-vsx',
                itemId: `sample/palette-${index}`, sourceUrl: 'https://open-vsx.org/api', format: 'open-vsx',
                importedAt: 1, ref: { kind: 'version', version: '1.0.0' } } },
            compatibility: { status: 'supported', unsupportedPaths: [] }, palette: { overrides: {}, radius: 'soft' } }),
    }));
    const persisted = rows.map(row => createPlainArtifactHttpFixture(row, scope.accountId));
    const catalog = createPromptLibraryCatalogBoundary();
    for (const path of ['/v1/account/entity-rows/prompt-library', '/v1/account/entity-rows/prompt-library/registry-sources']) {
        account.home.answer(home.serverId, `GET ${path}`, { select: async () => ({
            body: await (await catalog.handle(path))!.json(),
        }) });
    }
    // Public registry HTTP and Account HTTP are genuine boundaries; the theme tracker stays real.
    setRuntimeFetch(async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.origin === 'https://open-vsx.org') return Response.json({ namespace: 'sample',
            name: url.pathname.split('/')[3], version: '2.0.0', displayName: 'Palette',
            files: { manifest: 'https://open-vsx.org/manifest.json', download: 'https://open-vsx.org/package.vsix',
                sha256: 'https://open-vsx.org/package.sha256' } });
        return account.home.request(input, init);
    });
    for (const row of persisted) account.home.artifacts(home.serverId).replaceStoredRow(row);
    account.home.answer(home.serverId, 'GET /v1/artifacts', { select: async (_input, request) => ({ body:
        await createArtifactListHttpResponse(new URL(request.url), persisted).json(),
    }) });
    account.home.answer(home.serverId, '/v1/actions/browser.extensions.list', { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        return { body: { v: 1, actionId: 'browser.extensions.list', requestId: envelope.requestId,
            execution: { ok: true, result: { status: 'ready', entries: [] } } } };
    } });
    let checks = 0;
    account.home.answer(home.serverId, '/v1/actions/registries.updates.check', { select: body => {
        checks++;
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        return { body: { v: 1, actionId: 'registries.updates.check', requestId: envelope.requestId,
            execution: { ok: true, result: { checkedAt: 10, results: [] } } } };
    } });
    const screen = await renderScreen(<ModalProvider><PluginSurfaceFocusEligibilityProvider active>
        <StoreMachineScopeContext.Provider value={null}><StoreUpdatesScreen /></StoreMachineScopeContext.Provider>
    </PluginSurfaceFocusEligibilityProvider></ModalProvider>);
    await vi.waitFor(() => expect(screen.findAll(node => Array.isArray(node.props.families))[0]?.props.families
        .find((family: { kind: string }) => family.kind === 'theme')?.result.rows).toHaveLength(200));
    await vi.waitFor(() => expect(screen.findByTestId('store.updates.checkNow')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('store.updates.checkNow');
    await vi.waitFor(() => expect(checks).toBe(1));
    await vi.waitFor(() => expect(screen.tree.findAllByType(StoreUpdateRow).length, JSON.stringify({
        themeRows: screen.findAll(node => Array.isArray(node.props.families))[0]?.props.families
            .find((family: { kind: string }) => family.kind === 'theme')?.result.rows.length,
        failure: screen.findByTestId('store.updates.checkFailed')?.props.diagnosticCode,
    })).toBeGreaterThan(0));
    await act(async () => screen.findHostByTestId('store.updates')?.props.onLayout?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 960, height: 600 } },
    }));
    const mounted = screen.tree.findAllByType(StoreUpdateRow);
    console.info('[theme-window-cost] Store updates', { source: rows.length, mounted: mounted.length });
    expect(mounted.length).toBeLessThan(200);
    expect(mounted[0]!.findAll(node => typeof node.props.description === 'string'
        && node.props.description.includes('1.0.0 → 2.0.0')).length).toBeGreaterThan(0);
    const { router } = await import('expo-router');
    await screen.pressByTestIdAsync(`${mounted[0]!.props.testID}.review`);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/(app)/plugins/listing',
        params: { selection: JSON.stringify({ type: 'registryItem', kind: 'theme',
            ...mounted[0]!.props.entry.row.native.listing }) },
    }));
    await screen.unmount();
});

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

it('keeps Check now available before the first Apps-only observation', async () => {
    const scope = await account.restore({ currentAccount: true, serverIdentityId: 'srv_store_updates', machines: [
        createMachineFixture({ id: 'app-machine', activeAt: Date.now(), metadata: {
            ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: [] },
        } }),
    ] });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
        await import('@/sync/domains/plugins/availability/projection');
    const context = await captureLazyActionAccountContext(scope.serverId);
    const environment = createDeploymentEnvironmentHeaderV1({ serverId: context.accountLifetime.scope.serverId,
        controllerMachineId: 'app-machine', buildMachineId: 'app-machine',
        owner: { kind: 'account', accountId: scope.accountId } });
    try {
        replacePluginAccountAvailabilityProjection({ scope: context.accountLifetime.scope, snapshot: { availabilityCursor: 1,
            intentReads: [], materializations: [], snapshots: [], inventoryComplete: true } });
        await context.createArtifactDocument({ artifactId: environment.contentArtifactId,
            header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'App' },
            body: JSON.stringify(createDeploymentEnvironmentDetailV1({ environment }).content) });
        account.home.answer(scope.serverId, '/v1/deployments/environments', { body: { ok: true,
            items: [environment], runtimeTargetLinks: [], nextCursor: null, coverage: 'complete' } });
        account.home.answer(scope.serverId, '/v1/actions/browser.extensions.list', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            return { body: { v: 1, actionId: 'browser.extensions.list', requestId: envelope.requestId,
                execution: { ok: true, result: { status: 'ready', entries: [] } } } };
        } });
        const checks: unknown[] = [];
        account.home.answer(scope.serverId, '/v1/actions/registries.updates.check', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            checks.push(envelope.input);
            return { body: { v: 1, actionId: 'registries.updates.check', requestId: envelope.requestId,
                execution: { ok: true, result: { checkedAt: 10, results: [] } } } };
        } });
        const screen = await renderScreen(<ModalProvider><PluginSurfaceFocusEligibilityProvider active>
            <StoreUpdatesScreen />
        </PluginSurfaceFocusEligibilityProvider></ModalProvider>);
        // The real inventory must have admitted the App before we exercise its first check.
        await vi.waitFor(() => expect(screen.findAll(node => Array.isArray(node.props.families))[0]?.props.families
            .find((family: { kind: string }) => family.kind === 'app')?.result.rows).toHaveLength(1));
        expect(screen.findByTestId('store.updates.checkNow')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('store.updates.checkNow');
        await vi.waitFor(() => expect(checks).toContainEqual({}));
    } finally { clearPluginAccountAvailabilityProjection(); context.dispose(); }
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
