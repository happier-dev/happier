import * as React from 'react';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';
import { DeploymentTemplateV1Schema } from '@happier-dev/protocol/registries';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import { machinePresetActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { ItemList } from '@/components/ui/lists/ItemList';
import { createHydratedPlainMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { StoreMachineScopeContext, useStoreActionTarget } from '@/components/settings/plugins/model/useStoreMachineScope';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { ModalProvider } = await import('@/modal');
const { MachineSetupSection } = await import('./MachineSetupSection');
const { CapabilityAddModalBody } = await import('@/components/capabilities/add/CapabilityAddModal');
beforeEach(() => homes.reset());
afterEach(standardCleanup);

it('opens the preset Add dialog with every supported item family and preserves its unsaved draft on cancel', async () => {
    const serverId = await homes.addHome({ name: 'Preset Home', serverUrl: 'https://preset-authoring.test',
        serverIdentityId: 'srv_preset_authoring', accountId: 'owner', currentAccount: true });
    const setup = { scripts: [{ body: 'echo retained' }] };
    const onChange = vi.fn();
    const screen = await renderScreen(<ModalProvider><ItemList><MachineSetupSection editable scope={{ serverId, accountId: 'owner' }}
        name="Development" setup={setup} onChange={onChange} testID="preset.setup" /></ItemList></ModalProvider>);
    try {
        await act(async () => screen.pressByTestId('preset.setup.items.add'));
        const body = screen.tree.findByType(CapabilityAddModalBody);
        expect(body.props.config.modes.map((mode: { key: string }) => mode.key)).toEqual(['all', 'setup', 'software', 'apps']);
        await act(async () => body.props.onClose());
        expect(onChange).not.toHaveBeenCalled();
        expect(setup).toEqual({ scripts: [{ body: 'echo retained' }] });
        expect(homes.requestsFor(machinePresetActionEndpointPathV1('machines.presets.create'))).toHaveLength(0);
        expect(homes.requestsFor(machinePresetActionEndpointPathV1('machines.presets.update'))).toHaveLength(0);
    } finally { await screen.unmount(); }
});

it('retains the matching Store Machine and ignores a foreign Machine while adding every preset item without effects', async () => {
    onTestFinished(await installRealActionExecutorModuleLoader());
    const serverUrl = 'https://preset-catalog.test';
    const catalogUrl = `${serverUrl}/apps.json`;
    const sourceId = deriveMarketplaceSourceId(catalogUrl);
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: {
        v: 2, sources: [{ id: sourceId, title: 'Apps', url: catalogUrl, format: 'happier-catalog',
            kinds: ['app'], enabled: true, addedAt: 1 }], disabledSourceIds: [],
    } }] });
    const serverId = await homes.addHome({ name: 'Preset catalogs', serverUrl,
        serverIdentityId: 'srv_preset_catalogs', accountId: 'owner', currentAccount: true });
    for (const path of ['/v1/account/entity-rows/prompt-library', '/v1/account/entity-rows/prompt-library/registry-sources']) {
        homes.answer(serverId, path, { select: async () => ({ body: await (await catalog.handle(path))!.json() }) });
    }
    const app = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'Status page',
        compose: { document: 'services:\n  status:\n    image: example/status:1\n', profiles: [], services: ['status'] },
        variables: [], generatedSecrets: [], domains: [], volumes: [], firstRunSetup: true });
    homes.answer(serverId, '/apps.json', { body: { schemaVersion: 1, apps: [{ itemId: 'status-page', app }] } });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId);
    onTestFinished(() => account.dispose());
    const { PLUGIN_MANIFEST } = await import('../../../../../../../packages/plugins/machine-recipes/src/manifest');
    const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1, hostingCapability: { enabled: false },
        intent: { pluginId: PLUGIN_MANIFEST.id, desiredVersion: PLUGIN_MANIFEST.version, enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1' },
        release: { ref: { pluginId: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: PLUGIN_MANIFEST, collectionContracts: [], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } }, packageAssets: [], uiArtifacts: [] });
    const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    replacePluginAccountAvailabilityProjection({ scope: account.accountLifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [{ pluginId: PLUGIN_MANIFEST.id, response }], materializations: [], snapshots: [] } });
    // The preset belongs to its explicit Home even when another Account is selected in the shell.
    const otherHome = await homes.addHome({ name: 'Other Home', serverUrl: 'https://other-preset.test',
        serverIdentityId: 'srv_other_preset', accountId: 'other', currentAccount: true });
    const otherAccount = await captureLazyActionAccountContext(otherHome);
    onTestFinished(() => otherAccount.dispose());
    const foreignMachine = createHydratedPlainMachineFixture({ id: 'foreign-machine', accountId: 'other' });
    homes.answer(otherHome, '/v1/machines/foreign-machine', { body: { machine: createPlainMachineRowFixture({
        id: foreignMachine.id, accountId: 'other', machine: foreignMachine,
    }) } });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.getState().applyMachines([foreignMachine], false, { sourceServerId: otherHome, sourceAccountId: 'other' });
    const targets: { ambient?: ReturnType<typeof useStoreActionTarget>; preset?: ReturnType<typeof useStoreActionTarget>;
        matching?: ReturnType<typeof useStoreActionTarget> } = {};
    function TargetControl() {
        targets.ambient = useStoreActionTarget(undefined, true);
        targets.preset = useStoreActionTarget(undefined, true, account.accountLifetime.scope);
        targets.matching = useStoreActionTarget(undefined, true, otherAccount.accountLifetime.scope);
        return null;
    }
    const changes: MachineSetupV1[] = [];
    const screen = await renderScreen(<StoreMachineScopeContext.Provider value={{ serverId: otherHome, machineId: foreignMachine.id }}>
        <ModalProvider><TargetControl /><ItemList><MachineSetupSection editable scope={account.accountLifetime.scope}
        name="Development" setup={{ scripts: [{ body: 'echo retained' }] }} onChange={next => { if (next) changes.push(next); }} testID="preset.setup" /></ItemList></ModalProvider>
        </StoreMachineScopeContext.Provider>);
    try {
        await act(async () => screen.pressByTestId('preset.setup.items.add'));
        expect(targets.ambient).toEqual({ kind: 'machine', machineId: foreignMachine.id });
        await waitForHomeGovernance(() => expect(targets.matching).toEqual({ kind: 'machine', machineId: foreignMachine.id }));
        expect(targets.preset).toBeUndefined();
        const config = () => screen.tree.findByType(CapabilityAddModalBody).props.config;
        const pick = (id: string) => config().catalog.items.find((entry: unknown) => config().catalog.itemKey(entry).includes(id));
        await waitForHomeGovernance(() => expect(pick('ssh-hardening')).toBeDefined());
        await waitForHomeGovernance(() => expect(pick('status-page')).toBeDefined());
        expect(changes).toHaveLength(0);
        // One discovery read, before any item has been added.
        expect(homes.requestsFor('/apps.json').map(request => request.serverId)).toEqual([serverId]);
        // Tabs filter the same offered items; opening them never edits the draft.
        await act(async () => config().onModeChange('setup'));
        expect(pick('ssh-hardening')).toBeDefined();
        expect(pick('google-chrome')).toBeUndefined();
        expect(pick('status-page')).toBeUndefined();
        await act(async () => config().onModeChange('software'));
        await waitForHomeGovernance(() => expect(pick('google-chrome')).toBeDefined());
        expect(pick('ssh-hardening')).toBeUndefined();
        await act(async () => config().onModeChange('apps'));
        await waitForHomeGovernance(() => expect(pick('status-page')).toBeDefined());
        expect(pick('google-chrome')).toBeUndefined();
        await act(async () => config().onModeChange('all'));
        await waitForHomeGovernance(() => expect(pick('ssh-hardening')).toBeDefined());
        for (const id of ['ssh-hardening', 'google-chrome', 'status-page']) {
            await act(async () => { await config().detailFooter(pick(id)).primary.onPress(); });
        }
        expect(changes.at(-1)).toMatchObject({ scripts: [{ body: 'echo retained' }], items: [
            { kind: 'setupRecipe', selection: { ref: { recipeId: 'ssh-hardening' } } },
            { kind: 'softwareRecipe', selection: { ref: { recipeId: 'google-chrome' } } },
            { kind: 'app', definition: { name: 'Status page', project: { kind: 'create' }, definition: {
                from: 'catalogApp', templateRef: { sourceId, itemId: 'status-page', version: expect.any(String), ref: expect.any(Object) },
            } } },
        ] });
        // The listed App row (no pin read yet) is recognised by its catalog identity once added.
        const { t } = await import('@/text');
        await waitForHomeGovernance(() => expect(config().detailFooter(pick('status-page')).primary.disabledReason)
            .toBe(t('machinePresets.setup.alreadyInPreset')));
        expect(homes.requestsFor(machinePresetActionEndpointPathV1('machines.presets.create'))).toHaveLength(0);
        expect(homes.requestsFor(machinePresetActionEndpointPathV1('machines.presets.update'))).toHaveLength(0);
        expect(homes.requestsFor('/v1/artifacts').filter(request => request.method === 'POST')).toHaveLength(0);
        // The explicit App addition makes one selected read. Both reads belong to the preset's Account.
        expect(homes.requestsFor('/apps.json').map(request => request.serverId)).toEqual([serverId, serverId]);
    } finally { await screen.unmount(); }
});

it('edits a saved App address for each required template Domain and keeps it on the App intent', async () => {
    onTestFinished(await installRealActionExecutorModuleLoader());
    const serverUrl = 'https://preset-addresses.test';
    const catalogUrl = `${serverUrl}/apps.json`;
    const sourceId = deriveMarketplaceSourceId(catalogUrl);
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: {
        v: 2, sources: [{ id: sourceId, title: 'Apps', url: catalogUrl, format: 'happier-catalog',
            kinds: ['app'], enabled: true, addedAt: 1 }], disabledSourceIds: [],
    } }] });
    const serverId = await homes.addHome({ name: 'Preset addresses', serverUrl,
        serverIdentityId: 'srv_preset_addresses', accountId: 'owner', currentAccount: true });
    for (const path of ['/v1/account/entity-rows/prompt-library', '/v1/account/entity-rows/prompt-library/registry-sources']) {
        homes.answer(serverId, path, { select: async () => ({ body: await (await catalog.handle(path))!.json() }) });
    }
    const domainKey = 'SERVICE_URL_REDISINSIGHT_5540';
    const app = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'RedisInsight',
        compose: { document: 'services:\n  redisinsight:\n    image: redis/redisinsight:2\n', profiles: [], services: ['redisinsight'] },
        variables: [], generatedSecrets: [], volumes: [], firstRunSetup: true,
        domains: [{ key: domainKey, service: 'redisinsight', containerPort: 5540, protocol: 'http', required: true }] });
    homes.answer(serverId, '/apps.json', { body: { schemaVersion: 1, apps: [{ itemId: 'redisinsight', app }] } });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId);
    onTestFinished(() => account.dispose());
    const changes: (MachineSetupV1 | undefined)[] = [];
    function Host() {
        const [setup, setSetup] = React.useState<MachineSetupV1 | undefined>(undefined);
        return <MachineSetupSection editable scope={account.accountLifetime.scope} name="Data tools" setup={setup}
            onChange={next => { changes.push(next); setSetup(next); }} testID="preset.setup" />;
    }
    const screen = await renderScreen(<ModalProvider><ItemList><Host /></ItemList></ModalProvider>);
    try {
        await act(async () => screen.pressByTestId('preset.setup.items.add'));
        const config = () => screen.tree.findByType(CapabilityAddModalBody).props.config;
        const pick = () => config().catalog.items.find((entry: unknown) => config().catalog.itemKey(entry).includes('redisinsight'));
        await waitForHomeGovernance(() => expect(pick()).toBeDefined());
        await act(async () => { await config().detailFooter(pick()).primary.onPress(); });
        await act(async () => config().onClose?.());
        const field = `preset.setup.item.0.domain.${domainKey}`;
        await waitForHomeGovernance(() => expect(screen.findHostByTestId(field)).not.toBeNull());
        await act(async () => screen.findHostByTestId(field)!.props.onChangeText('redis.example.com'));
        expect(changes.at(-1)?.items?.[0]).toMatchObject({ kind: 'app', definition: { name: 'RedisInsight',
            domainBindings: [{ templateDomainId: domainKey, hostname: 'redis.example.com' }] } });
        await act(async () => screen.findHostByTestId(field)!.props.onChangeText(''));
        const cleared = changes.at(-1)?.items?.[0];
        expect(cleared?.kind === 'app' && 'domainBindings' in cleared.definition).toBe(false);
        expect(homes.requestsFor(machinePresetActionEndpointPathV1('machines.presets.update'))).toHaveLength(0);
    } finally { await screen.unmount(); }
});
