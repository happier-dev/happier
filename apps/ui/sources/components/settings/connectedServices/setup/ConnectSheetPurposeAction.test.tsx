/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { PLUGIN_MANIFEST as GITLAB_MANIFEST } from '../../../../../../../packages/plugins/scm-gitlab/src/manifest';
import { GITLAB_CONNECTED_ACCOUNT_ID, GITLAB_CONNECTED_ACCOUNT_PURPOSE, GITLAB_TRIAGE_ACTION_IDS } from '../../../../../../../packages/plugins/scm-gitlab/src/triage/contribution';
import { GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID } from '../../../../../../../packages/plugins/scm-gitlab/src/auth/connectedAccountRuntime';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The Account harness imports native UI leaves during collection; install the
// DOM boundary in the hoisted factory before those imports are evaluated.
vi.mock('react-native', async () => {
    const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
    const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
    return await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
});
vi.mock('@/text', async () => await vi.importActual('@/text'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsRealModule());
vi.mock('react-native-keyboard-controller', async () => {
    const { View } = await import('react-native');
    return { KeyboardAvoidingView: View };
});
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// This unused native Markdown package is outside the host process.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => { throw new Error('Unexpected Markdown in Connect'); } }));

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { openPluginConnectedAccountSheet } = await import('@/components/plugins/surfaces/openPluginConnectedAccountSheet');
const { ModalProvider } = await import('@/modal');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
    await import('@/sync/domains/plugins/availability/projection');
const { storage } = await import('@/sync/domains/state/storage');
const { resetConnectedAccountCatalogEngineForTests } = await import('@/sync/engine/settings/connectedAccountCatalogEngine');
const { resetConnectedAccountCatalogSnapshotsForTests } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
const gitlab = PluginPortableReleaseManifestV1Schema.parse(GITLAB_MANIFEST);
const features = createRootLayoutFeaturesResponse({ capabilities: { connectedServices: {
    credentialDelete: { revisionGuard: false },
    qualifiedAccounts: { protocolVersion: 4 },
} } });
function installPurposeDeclarations() {
    return installBundledPluginUiDeclarationsForTests([
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

it.each([390, 1440])('changes an Account purpose through the plugin Host producer with a selected Machine and real Connect picker (%i px)', async (width) => {
    onTestFinished(installPurposeDeclarations());
    onTestFinished(await installRealActionExecutorModuleLoader());
    const scope = await account.restore({ machines: [], currentAccount: true, features,
        waivedActions: ['connectedServices.purposes.default.set'] });
    const purpose = { consumer: { pluginId: gitlab.id, localId: GITLAB_TRIAGE_ACTION_IDS.listInstances },
        purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE };
    const service = { pluginId: gitlab.id, localId: GITLAB_CONNECTED_ACCOUNT_ID };
    const previous = QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service, accountId: 'previous' },
        status: 'connected', authenticationModeId: GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID,
        revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
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
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 900 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    window.dispatchEvent(new Event('resize'));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    onTestFinished(async () => { await act(async () => root.unmount()); container.remove(); });
    // Settings mounts its route host after the app host has registered.
    await act(async () => root.render(<ModalProvider><React.Fragment /></ModalProvider>));
    await act(async () => root.render(<ModalProvider><InjectedAuthProvider credentials={null}>
        <ModalProvider active><React.Fragment /></ModalProvider>
    </InjectedAuthProvider></ModalProvider>));
    const chooser = `connected-account-purpose:${service.pluginId}/${service.localId}`;
    async function openPicker(capturedScope = scope) {
        let result!: ReturnType<typeof openPluginConnectedAccountSheet>;
        await act(async () => { result = openPluginConnectedAccountSheet({ scope: capturedScope, request: { service, purpose },
            machineId: 'unavailable-selected-machine', serverId: capturedScope.serverId }); });
        await vi.waitFor(() => {
            const trigger = document.querySelector<HTMLElement>(`[data-testid="${chooser}"]`);
            expect(trigger).not.toBeNull();
            expect(trigger?.getAttribute('aria-disabled')).not.toBe('true');
        });
        let settled = false;
        void result.then(() => { settled = true; });
        await act(async () => document.querySelector<HTMLElement>(`[data-testid="${chooser}"]`)!.click());
        expect(settled, 'Opening a nested purpose picker must keep its Account sheet alive').toBe(false);
        return { result };
    }
    async function choose(accountId: string) {
        const choice = await vi.waitFor(() => {
            const found = Array.from(document.querySelectorAll<HTMLElement>('[data-testid]')).find(node =>
                node.dataset.testid?.startsWith(`${chooser}:choice:`) && node.dataset.testid.includes(accountId));
            expect(found).toBeDefined();
            expect(found?.getAttribute('aria-disabled')).not.toBe('true');
            return found!;
        });
        await act(async () => {
            choice!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
            choice!.click();
        });
    }
    const { result } = await openPicker();
    expect(writes).toBe(0);
    await choose('previous');
    await vi.waitFor(() => expect(writes, document.body.textContent ?? '').toBe(1));
    await expect(result).resolves.toEqual({ kind: 'selected', account: previous.ref });
    expect(value.bindings).toEqual([{ purpose, target: { kind: 'account', account: previous.ref } }]);

    const retiring = await openPicker();
    await act(async () => { await account.home.switchAccount(scope.serverId, 'replacement-account', { currentAccount: true }); });
    await expect(retiring.result).resolves.toEqual({ kind: 'dismissed' });
    expect(writes).toBe(1);

    const restoredScope = await account.restore({ machines: [], currentAccount: true, features,
        waivedActions: ['connectedServices.purposes.default.set'] });
    replacePluginAccountAvailabilityProjection({ scope: restoredScope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    await readPluginAccountAvailability(restoredScope).ensureCurrentAccountExecution(gitlab.id);
    storage.getState().applyProfile({ ...storage.getState().profile, connectedAccountsV4: [previous, current] });
    const recovered = await openPicker(restoredScope);
    await choose('current');
    await vi.waitFor(() => expect(writes).toBe(2));
    await expect(recovered.result).resolves.toEqual({ kind: 'selected', account: current.ref });
    expect(value.bindings).toEqual([{ purpose, target: { kind: 'account', account: current.ref } }]);
    expect(rpc.state.requests).toHaveLength(0);
});
