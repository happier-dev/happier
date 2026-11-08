import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

installPromptRegistriesCommonModuleMocks({ storage: original => original() });
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

const { StoreKindFrame, kindCopy } = await import('./StoreKindPage');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { NavigationTitleChromeProvider } = await import('@/components/ui/layout/navigationTitleChrome');

afterEach(standardCleanup);

it("names a kind page in the phone's bar instead of the Store's name (lab wp/kind)", async () => {
    const titles: (string | null | undefined)[] = [];
    const publisher = { setTitle: (title: string | null | undefined) => { titles.push(title); } };
    await renderScreen(
        <AppPaneProvider>
            <NavigationTitleChromeProvider showsTitle showsBack={false} publisher={publisher}>
                <StoreKindFrame kind="bot" query="" onQueryChange={() => {}} presented={false}>{null}</StoreKindFrame>
            </NavigationTitleChromeProvider>
        </AppPaneProvider>,
    );
    const published = titles.filter((title): title is string => typeof title === 'string');
    // The bar carries the kind's own page title; the body keeps the purpose line.
    expect(published).toEqual([kindCopy('bot').title]);
});
