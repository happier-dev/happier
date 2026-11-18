import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

installPromptRegistriesCommonModuleMocks({ storage: original => original() });
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

const { StoreKindFrameBody } = await import('./StoreKindPage');
const { StoreListingPaneOpenContext } = await import('./StoreListing');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { Text } = await import('@/components/ui/text/Text');

afterEach(standardCleanup);

const head = (paneOpen: boolean) => (
    <AppPaneProvider>
        <StoreListingPaneOpenContext.Provider value={paneOpen}>
            <StoreKindFrameBody kind="app" title="Apps" description="Apps you can deploy." search="Search apps" stacked={false}
                scoped createEntry={null} scopeChip={null} query="" onQueryChange={() => {}}
                registrySelect={<Text testID="store.kind.app.catalog">All catalogs</Text>}>
                {null}
            </StoreKindFrameBody>
        </StoreListingPaneOpenContext.Provider>
    </AppPaneProvider>
);

// UI refinements 2026-11-18 (Store toolbar): with a listing beside it the head keeps one toolbar row; the catalog choice
// is the search filter menu's Source condition, so it leaves the band.
it('keeps the catalog choice in the band only while no listing stands beside the directory', async () => {
    const closed = await renderScreen(head(false));
    expect(closed.findByTestId('store.kind.app.catalog')).not.toBeNull();
    await closed.unmount();
    const open = await renderScreen(head(true));
    expect(open.findByTestId('store.kind.app.catalog')).toBeNull();
});
