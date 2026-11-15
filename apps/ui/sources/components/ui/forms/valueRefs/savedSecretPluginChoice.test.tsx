import 'fake-indexeddb/auto';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { resetSavedSecretCatalogEngineForTests, refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { settingsParse } from '@/sync/domains/settings/settings';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await vi.hoisted(async () => {
    const { installValueRefsCommonModuleMocks } = await import('./valueRefsTestHelpers');
    installValueRefsCommonModuleMocks({
        storage: importOriginal => importOriginal(),
        modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
    });
});

// The real store, catalog, host presentation and public plugin component, below the network/platform boundaries.
const { SavedSecretChoiceList } = await import('@happier-dev/plugin-ui/components');
const { PluginUiPresentationHostProviderInternal } = await import('../../../../../../../packages/plugin-ui/src/presentationHost/context');
const { createPluginUiPrivatePresentationHost } = await import('@/components/plugins/surfaces/pluginUiPrivatePresentationHost');
let home: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

beforeEach(async () => {
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
    await refreshSavedSecretCatalog(home.scope);
});
afterEach(async () => {
    await standardCleanup();
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    await home?.dispose();
    home = undefined;
});

describe('plugin saved-secret choice', () => {
    it('draws the host list over the signed-in Account catalog and returns the chosen reference', async () => {
        const { entry } = await home!.addOwnerResource();
        await refreshSavedSecretCatalog(home!.scope, { includeMaterial: true });
        const onSelect = vi.fn();
        const screen = await renderScreen(
            <PluginUiPresentationHostProviderInternal host={createPluginUiPrivatePresentationHost(undefined)}>
                <SavedSecretChoiceList testIDPrefix="author" selectedRef={null} onSelect={onSelect} />
            </PluginUiPresentationHostProviderInternal>,
        );
        const rowID = `author:saved:${entry.ref}`;
        await vi.waitFor(() => expect(screen.findAllByTestId(rowID)
            .find(node => node.props.title === entry.name)?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync(rowID);
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect.mock.calls[0]![0]).toEqual({ ref: entry.ref, resourceRevision: expect.any(Number) });
    });
});
