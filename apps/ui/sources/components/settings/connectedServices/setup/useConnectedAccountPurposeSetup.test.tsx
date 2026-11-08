import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { PLUGIN_MANIFEST } from '../../../../../../../packages/plugins/scm-github/src/manifest';
import { GITHUB_TRIAGE_ACTION_IDS_V1 } from '../../../../../../../packages/plugins/scm-github/src/triage/contribution';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_CONNECTED_ACCOUNT_SERVICE } from '../../../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import type { ConnectedAccountPurposeSetupRequest } from '@/sync/domains/connectedServices/connectedAccountPurposeSetup';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { PLUGIN_MANIFEST as GITLAB_MANIFEST } from '../../../../../../../packages/plugins/scm-gitlab/src/manifest';
import { GITLAB_CONNECTED_ACCOUNT_ID, GITLAB_CONNECTED_ACCOUNT_PURPOSE, GITLAB_TRIAGE_ACTION_IDS } from '../../../../../../../packages/plugins/scm-gitlab/src/triage/contribution';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { useConnectedAccountPurposeSetup } = await import('./useConnectedAccountPurposeSetup');
const { useConnectedAccountPurposeDefaults } = await import('@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults');
const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
    await import('@/sync/domains/plugins/availability/projection');
const { storage } = await import('@/sync/domains/state/storage');
const { resetConnectedAccountCatalogEngineForTests } = await import('@/sync/engine/settings/connectedAccountCatalogEngine');
const { resetConnectedAccountCatalogSnapshotsForTests } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);
const gitlab = PluginPortableReleaseManifestV1Schema.parse(GITLAB_MANIFEST);
function installPurposeDeclarations() {
    return installBundledPluginUiDeclarationsForTests([
        { pluginId: manifest.id, pluginVersion: manifest.version, packageName: '@happier-dev/plugins-scm-github',
            displayName: 'GitHub', entriesById: {}, normalizedManifest: manifest },
        { pluginId: gitlab.id, pluginVersion: gitlab.version, packageName: '@happier-dev/plugins-scm-gitlab',
            displayName: 'GitLab', entriesById: {}, normalizedManifest: gitlab },
    ]);
}

afterEach(async () => {
    await standardCleanup();
    clearPluginAccountAvailabilityProjection();
    await account.reset();
    resetConnectedAccountCatalogEngineForTests();
    resetConnectedAccountCatalogSnapshotsForTests();
});

it.each(['plain', 'e2ee'] as const)('admits the GitHub source purpose in its %s Account without a Machine and rejects foreign scope or undeclared purposes', async mode => {
    onTestFinished(installPurposeDeclarations());
    const scope = await account.restore({ machines: [], ...(mode === 'e2ee' ? { e2eeSecret: new Uint8Array(32).fill(7) } : {}) });
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const reader = readPluginAccountAvailability(scope);
    const admitted = await reader.ensureCurrentAccountExecution(manifest.id);
    expect(admitted.kind).toBe('available');
    const connected = QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'github-owner' },
        status: 'connected', authenticationModeId: 'pat', revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        configurationReady: true, configurationRevision: null, displayName: 'Owner', scopes: [] });
    storage.getState().applyProfile({ ...storage.getState().profile, connectedAccountsV4: [connected] });
    let request: ConnectedAccountPurposeSetupRequest = { scope, purpose: {
        consumer: { pluginId: manifest.id, localId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances }, purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE } };
    const selected = vi.fn();
    const hook = await renderHook(() => useConnectedAccountPurposeSetup({ request, onSelected: selected, onClose() {} }));
    await vi.waitFor(() => expect(hook.getCurrent().unavailableReason).toBeNull());
    expect(hook.getCurrent().declaration).toMatchObject({ consumerKind: 'action', serviceRefs: [GITHUB_CONNECTED_ACCOUNT_SERVICE] });
    expect(hook.getCurrent().registry?.entries.some(entry => entry.service?.pluginId === manifest.id)).toBe(true);
    await act(async () => { expect(await hook.getCurrent().select({ kind: 'account', account: connected.ref })).toEqual(connected.ref); });
    expect(selected).toHaveBeenCalledWith(connected.ref, 'selected');
    expect(rpc.state.requests).toHaveLength(0);
    const ownRequest = request;
    request = { ...ownRequest, scope: { ...scope, accountId: 'another-account' } };
    await hook.rerender();
    expect(hook.getCurrent().unavailableReason).toBe('profile_account_mismatch');
    request = { ...ownRequest, purpose: { ...ownRequest.purpose, purpose: 'undeclared-purpose' } };
    await hook.rerender();
    expect(hook.getCurrent().unavailableReason).toBe('purpose_unavailable');
    request = { ...ownRequest, machineId: 'unavailable-machine' };
    await hook.rerender();
    expect(hook.getCurrent().unavailableReason).toBe('purpose_unavailable');
    request = ownRequest;
    await hook.rerender();
    expect(hook.getCurrent().unavailableReason).toBeNull();
    await hook.unmount();
});

it.each(['updated', 'denied', 'cold'] as const)('settles an Account GitLab purpose choice through the real Action without a Machine (%s)', async outcome => {
    onTestFinished(installPurposeDeclarations());
    onTestFinished(await installRealActionExecutorModuleLoader());
    const scope = await account.restore({ machines: [], currentAccount: true,
        waivedActions: ['connectedServices.purposes.default.set'] });
    const purpose = { consumer: { pluginId: gitlab.id, localId: GITLAB_TRIAGE_ACTION_IDS.listInstances },
        purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE };
    const service = { pluginId: gitlab.id, localId: GITLAB_CONNECTED_ACCOUNT_ID };
    const previous = QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service, accountId: 'previous' },
        status: 'connected', authenticationModeId: 'pat', revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        configurationReady: true, configurationRevision: null, displayName: 'Previous', scopes: [] });
    const current = { ...previous, ref: { service, accountId: 'current' }, displayName: 'Current' };
    let value: ConnectedPurposeCatalogV1 = { v: 1, bindings: [{ purpose, target: { kind: 'account', account: current.ref } }] };
    let revision = 3;
    let writes = 0;
    const route = '/v1/account/entity-rows/connected-accounts/purposes';
    account.home.answer(scope.serverId, `GET ${route}`, { select: () => ({ body: {
        status: 'present', revision, content: { t: 'plain', v: { key: 'purposes', value } },
    } }) });
    account.home.answer(scope.serverId, `POST ${route}`, { select: input => {
        if (outcome === 'denied') return { status: 403, body: { error: 'forbidden' } };
        const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(input);
        expect(mutation.expectedRevision).toBe(revision);
        if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'purposes') throw new Error('Expected a plain purpose catalog');
        value = mutation.content.v.value;
        revision += 1;
        writes += 1;
        return { body: { status: 'updated', revision, cursor: revision } };
    } });
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const admission = await readPluginAccountAvailability(scope).ensureCurrentAccountExecution(gitlab.id);
    expect(admission).toMatchObject({ kind: 'available' });
    storage.getState().applyProfile({ ...storage.getState().profile, connectedAccountsV4: [previous, current] });
    const onClose = vi.fn();
    const hook = await renderHook(() => ({
        setup: useConnectedAccountPurposeSetup({ request: outcome === 'cold' ? null : { scope, purpose }, onClose }),
        defaults: useConnectedAccountPurposeDefaults(undefined, { enabled: false }),
    }));
    if (outcome === 'cold') {
        // A mounted caller may dispatch before its presentation projection is hydrated.
        // The Action writer owns the fresh catalog read and expected revision.
        await vi.waitFor(() => expect(hook.getCurrent().defaults.execution.ready).toBe(true));
        expect(hook.getCurrent().defaults.catalog.value).toBeNull();
    } else {
        await vi.waitFor(() => expect(hook.getCurrent().setup.selectionDisabled).toBe(false));
        await vi.waitFor(() => expect(hook.getCurrent().setup.declaration).toMatchObject({ consumerKind: 'action', serviceRefs: [service] }));
    }
    const target = { kind: 'account' as const, account: previous.ref };
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.alert).mockClear();
    await act(async () => {
        if (outcome === 'cold') {
            expect(await hook.getCurrent().defaults.mutateDefaults({ kind: 'resource', input: { purpose, target } })).toBe(true);
            return;
        }
        const selected = await hook.getCurrent().setup.select(target);
        if (outcome === 'updated') {
            expect(selected).toEqual(previous.ref);
            expect(Modal.alert).not.toHaveBeenCalled();
        }
        else expect(selected).toBeNull();
    });
    if (outcome !== 'denied') {
        expect(value.bindings).toEqual([{ purpose, target }]);
        expect(writes).toBe(1);
        if (outcome === 'updated') {
            expect(onClose).toHaveBeenCalledOnce();
            expect(hook.getCurrent().setup.selected).toEqual(target);
        }
    } else {
        expect(writes).toBe(0);
        expect(onClose).not.toHaveBeenCalled();
        const { t } = await import('@/text');
        const details = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2]?.find(button => button.text === t('approvals.technicalDetails'));
        expect(details).toBeDefined();
        details?.onPress?.();
        expect(JSON.parse(vi.mocked(Modal.alert).mock.calls.at(-1)![1]!)).toEqual({
            code: 'connected_account_catalog_http_403', requestId: expect.any(String),
        });
    }
    expect(rpc.state.requests).toHaveLength(0);
    await hook.unmount();
});
