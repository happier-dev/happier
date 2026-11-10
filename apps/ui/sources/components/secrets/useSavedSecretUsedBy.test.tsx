import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as React from 'react';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import * as census from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { settingsParse } from '@/sync/domains/settings/settings';
import { applyProfileCatalogSnapshot } from '@/sync/store/settings/profileCatalogSnapshot';
import { applyProviderCatalogSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
import { applyMcpServerCatalogSnapshot } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { applyAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';
import { applyConnectedAccountCatalogSnapshot } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { applyNotificationChannelCatalogSnapshot } from '@/sync/store/settings/notificationChannelCatalogSnapshot';
import { applyPromptLibraryCatalogSnapshot } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { applyRemoteHostCatalogSnapshot, getRemoteHostCatalogSnapshot, invalidateRemoteHostCatalog } from '@/sync/store/settings/remoteHostCatalogSnapshot';
import { applyConnectedMetadataCatalogSnapshot } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { applySavedSecretCatalogPage } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { readSavedSecretUsedBy } from '@/sync/store/settings/savedSecretUsedBy';

installSettingsViewCommonModuleMocks({ storage: 'real' });
afterEach(async () => { await standardCleanup(); vi.restoreAllMocks(); resetRuntimeFetch(); });
let accountFixture = 0;
function heldAccount() {
    const scope = { serverId: `secret-used-by-test-${++accountFixture}`, accountId: 'account-a' };
    getStorage().setState({ settingsScope: scope, settings: settingsParse({ secrets: [] }),
        profile: AccountProfileSchema.parse({ id: scope.accountId }) });
    const request = vi.fn(async () => new Response('{}', { status: 404 }));
    setRuntimeFetch(request);
    return { scope, request };
}

it('opens one secret with one real census, zero fetches and no rereads on renders or sibling-Home pushes', async () => {
    const home = heldAccount();
    const scope = home.scope;
    const ref = census.formatSharedSavedSecretRefV1('selected');
    applySavedSecretCatalogPage({ scope, observedAt: 1, materializedSecrets: [], entries: ['selected', 'other'].map(id =>
        SavedSecretCatalogEntryV1Schema.parse({ ref: census.formatSharedSavedSecretRefV1(id), source: 'shared_resource',
            relationship: 'owner', name: 'Key', kind: 'apiKey', revision: 1, materialStatus: 'ready',
            deploymentReferenceState: 'unreferenced', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } })) });
    const template = buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-chat'),
        name: 'Northwind', baseUrl: 'https://models.example/v1', requiresApiKey: true });
    const providers = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        connections: [{ v: 1, id: 'pc_northwind', source: { kind: 'custom', template }, role: 'named',
            displayName: 'Northwind models', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        secretBindingsByConnectionId: { pc_northwind: { account: { apiKey: ref }, byMachineId: {} } },
    });
    applyProfileCatalogSnapshot(scope, { status: 'ready', authority: 'inactive', source: 'destination', control: null,
        controlRevision: 'absent', records: [], diagnostics: [], referenceGuardRevision: 1 }, true);
    applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 1, catalog: providers }, true);
    applyMcpServerCatalogSnapshot(scope, { status: 'ready', authority: 'active', revision: 1,
        catalog: { v: 1, servers: [], bindings: [] }, diagnostics: [] }, true);
    applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1,
        record: { v: 1, definitions: [] } }, true);
    applyConnectedAccountCatalogSnapshot(scope, 'configurations', { status: 'ready', revision: 1,
        record: { key: 'configurations', value: { v: 1, entries: [] } } }, true);
    applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 1,
        record: { key: 'purposes', value: { v: 1, bindings: [] } } }, true);
    applyNotificationChannelCatalogSnapshot(scope, { catalog: { status: 'ready', revision: 1, channels: [], diagnostics: [] },
        rawSettings: {}, sourceSettingsVersion: 1 }, true);
    applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision: 1, record: {
        key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
    } }], diagnostics: [], tombstones: [] }, rawSettings: {}, sourceSettingsVersion: 1 }, true);
    applyRemoteHostCatalogSnapshot(scope, { status: 'ready', hosts: [], diagnostics: [], revision: 1 }, true);
    // Call-through observation of the public census owner: no internal behavior is replaced.
    const reads = vi.spyOn(census, 'listAccountSettingsSavedSecretReferences');
    const requestsBefore = home.request.mock.calls.length;
    const { useSavedSecretUsedBy } = await import('./useSavedSecretUsedBy');
    let presented = true;
    function Wrapper({ children }: React.PropsWithChildren) {
        return <PluginSurfaceFocusEligibilityProvider active={false} presentationActive={presented}>{children}</PluginSurfaceFocusEligibilityProvider>;
    }
    const hook = await renderHook(({ selected }) => useSavedSecretUsedBy(scope, selected), { initialProps: { selected: ref }, wrapper: Wrapper });
    expect(hook.getCurrent()).toMatchObject([{ owner: 'provider', referrer: { id: 'pc_northwind', displayName: 'Northwind models' } }]);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls[0]?.[1]).toBe(ref);
    const first = hook.getCurrent();
    await act(async () => getStorage().setState(state => ({ settings: { ...state.settings, themePreference: 'dark' } })));
    expect(hook.getCurrent()).toBe(first);
    expect(reads).toHaveBeenCalledTimes(1);
    await hook.rerender();
    await act(async () => applyProviderCatalogSnapshot({ ...scope, accountId: 'sibling' },
        { status: 'ready', revision: 1, catalog: providers }, true));
    expect(hook.getCurrent()).toBe(first);
    expect(reads).toHaveBeenCalledTimes(1);
    await act(async () => applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 2,
        catalog: { ...providers, secretBindingsByConnectionId: {} } }, true));
    expect(hook.getCurrent()).toEqual([]);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(home.request.mock.calls).toHaveLength(requestsBefore);
    const environmentEntry = SavedSecretCatalogEntryV1Schema.parse({ ref, source: 'shared_resource', relationship: 'owner',
        name: 'Key', kind: 'apiKey', revision: 1, materialStatus: 'ready', deploymentReferenceState: 'referenced',
        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } });
    await act(async () => applySavedSecretCatalogPage({ scope, observedAt: 2, materializedSecrets: [], entries: [environmentEntry] }));
    expect(hook.getCurrent()).toEqual([{ owner: 'deploymentEnvironment', path: 'deploymentEnvironments.bindings' }]);
    expect(readSavedSecretUsedBy(scope, ref)).toEqual(hook.getCurrent());
    const readsBeforeSiblingSecret = reads.mock.calls.length;
    await act(async () => applySavedSecretCatalogPage({ scope, observedAt: 3, materializedSecrets: [], entries: [
        environmentEntry, { ...environmentEntry, ref: census.formatSharedSavedSecretRefV1('other'), name: 'Renamed sibling' },
    ] }));
    expect(reads).toHaveBeenCalledTimes(readsBeforeSiblingSecret);
    await act(async () => applySavedSecretCatalogPage({ scope, observedAt: 4, materializedSecrets: [], entries: [
        { ...environmentEntry, deploymentReferenceState: 'unreferenced' },
    ] }));
    expect(hook.getCurrent()).toEqual([]);
    await act(async () => applySavedSecretCatalogPage({ scope, observedAt: 5, materializedSecrets: [], entries: [
        { ...environmentEntry, deploymentReferenceState: 'unavailable' },
        { ...environmentEntry, ref: census.formatSharedSavedSecretRefV1('other'), deploymentReferenceState: 'unreferenced' },
    ] }));
    expect(readSavedSecretUsedBy(scope, ref)).toBeNull();
    expect(hook.getCurrent()).toBeNull();
    const readsBeforeOther = reads.mock.calls.length;
    const otherRef = census.formatSharedSavedSecretRefV1('other');
    await hook.rerender({ selected: otherRef });
    expect(hook.getCurrent()).toEqual([]);
    expect(reads).toHaveBeenCalledTimes(readsBeforeOther + 1);
    expect(reads.mock.calls.at(-1)?.[1]).toBe(otherRef);
    const account = { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, accountId: 'work' };
    await act(async () => {
        getStorage().setState({ profile: AccountProfileSchema.parse({ id: scope.accountId, connectedAccountsV4: [{
            ref: account, displayName: 'Provider name', status: 'connected', authenticationModeId: 'api-key',
            revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            configurationReady: true, configurationRevision: null, savedSecretResourceIds: ['other'],
        }] }) });
        applyConnectedMetadataCatalogSnapshot(scope, { presentation: { status: 'ready', revision: 1,
            entries: [{ v: 1, subject: { kind: 'account', account }, label: 'Work credential' }], diagnostics: [] },
            acknowledgements: { status: 'loading' } }, true);
    });
    expect(hook.getCurrent()).toMatchObject([{ owner: 'connectedAccountCredential',
        referrer: { id: JSON.stringify(['account', account.service.pluginId, account.service.localId, account.accountId]), displayName: 'Work credential' } }]);
    expect(reads).toHaveBeenCalledTimes(readsBeforeOther + 2);
    expect(home.request.mock.calls).toHaveLength(requestsBefore);
    // A catalog revalidating is not "unknown": the page keeps the last census until the next one settles.
    const settled = hook.getCurrent();
    await act(async () => invalidateRemoteHostCatalog(scope));
    expect(getRemoteHostCatalogSnapshot(scope)?.catalog.status).not.toBe('ready');
    expect(hook.getCurrent()).toBe(settled);
    expect(reads).toHaveBeenCalledTimes(readsBeforeOther + 2);
    await hook.rerender({ selected: '' });
    expect(hook.getCurrent()).toBeNull();
    expect(reads).toHaveBeenCalledTimes(readsBeforeOther + 2);
    await act(async () => applyRemoteHostCatalogSnapshot(scope, { status: 'ready', hosts: [], diagnostics: [], revision: 1 }, true));
    await hook.rerender({ selected: otherRef });
    const beforeHidden = reads.mock.calls.length;
    const retained = hook.getCurrent();
    presented = false;
    await hook.rerender();
    await act(async () => getStorage().setState({
        profile: AccountProfileSchema.parse({ id: scope.accountId }),
        settings: settingsParse({ ...getStorage().getState().settings, futureCarrier: { secretRef: otherRef } }),
    }));
    expect(hook.getCurrent()).toBe(retained);
    expect(reads).toHaveBeenCalledTimes(beforeHidden);
    presented = true;
    await hook.rerender();
    expect(hook.getCurrent()).toEqual([{ owner: 'unknown', path: 'futureCarrier.secretRef' }]);
    expect(reads).toHaveBeenCalledTimes(beforeHidden + 1);
});

it('does no census work on a hidden retained surface and reads current sources once when shown', async () => {
    const { scope } = heldAccount();
    const { useSavedSecretUsedBy, useSavedSecretUsedBySourcesDemand } = await import('./useSavedSecretUsedBy');
    const sources = await import('@/sync/store/settings/savedSecretUsedBy');
    // Call-through instrumentation of the actual source reader, with real stores underneath.
    const reads = vi.spyOn(sources, 'readSavedSecretUsedBySources');
    const demand = vi.spyOn(sources, 'observeSavedSecretUsedBySources');
    let presented = false;
    function Wrapper({ children }: React.PropsWithChildren) {
        return <PluginSurfaceFocusEligibilityProvider active={false} presentationActive={presented}>{children}</PluginSurfaceFocusEligibilityProvider>;
    }
    const hook = await renderHook(() => {
        useSavedSecretUsedBySourcesDemand(scope);
        return useSavedSecretUsedBy(scope, 'selected');
    }, { wrapper: Wrapper });
    expect(reads).not.toHaveBeenCalled();
    expect(demand).not.toHaveBeenCalled();
    await act(async () => { for (let index = 0; index < 5; index++) getStorage().setState({ settingsVersion: index }); });
    expect(reads).not.toHaveBeenCalled();
    presented = true;
    await hook.rerender();
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    expect(demand).toHaveBeenCalledTimes(1);
    const shownReads = reads.mock.calls.length;
    presented = false;
    await hook.rerender();
    await act(async () => { for (let index = 5; index < 10; index++) getStorage().setState({ settingsVersion: index }); });
    expect(reads).toHaveBeenCalledTimes(shownReads);
});

it('keeps missing coverage and a foreign Account unknown without fetching', async () => {
    const home = heldAccount();
    const { useSavedSecretUsedBy } = await import('./useSavedSecretUsedBy');
    const before = home.request.mock.calls.length;
    const reads = vi.spyOn(census, 'listAccountSettingsSavedSecretReferences');
    const hook = await renderHook(({ accountId }) => useSavedSecretUsedBy({ ...home.scope, accountId },
        census.formatSharedSavedSecretRefV1('one')), { initialProps: { accountId: home.scope.accountId } });
    expect(hook.getCurrent()).toBeNull();
    await hook.rerender({ accountId: 'not-held' });
    expect(hook.getCurrent()).toBeNull();
    expect(reads).not.toHaveBeenCalled();
    expect(home.request.mock.calls).toHaveLength(before);
});
