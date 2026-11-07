import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';
import { createDefaultCollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

import { CollectionSpaceTitle } from './CollectionSpaceTitle';

const base = createDefaultCollectionSpaceV1('sessionWork');
function Host({ scope, spacesEnabled = true, onSetSpacesEnabled }: Readonly<{
    scope: string; spacesEnabled?: boolean | null; onSetSpacesEnabled?: (next: boolean) => void;
}>) {
    const [selected, setSelected] = React.useState('a');
    return <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
        <CollectionSpaceTitle scope={scope} testIDPrefix="space" entityKind="sessionWork" label="Sessions"
            spaces={spacesEnabled ? [{ ...base, id: scope === 'account-a' ? 'a' : 'b', name: scope }] : []}
            spacesEnabled={spacesEnabled} onSetSpacesEnabled={onSetSpacesEnabled ?? (() => {})}
            selectedSpaceId={selected} modified={false} onSelectSpace={setSelected}
            onOpenFilter={() => {}} onSaveAs={() => {}} onSaveChanges={() => {}} onEdit={() => {}} />
    </HappierUiPlatformProvider>;
}
const menuIds = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.tree
    .findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('space-menu') && typeof node.type === 'string')
    .map(node => node.props.testID as string).filter((id, index, all) => !id.endsWith(':scroll-frame') && all.indexOf(id) === index);

describe('spaces switch in the title menu', () => {
    it('shows spaces with their switch on, and turning it off writes this list\'s switch', async () => {
        const onSetSpacesEnabled = vi.fn();
        const screen = await renderScreen(<Host scope="account-a" onSetSpacesEnabled={onSetSpacesEnabled} />);
        await screen.pressByTestIdAsync('space-title');
        await vi.waitFor(() => expect(screen.findByTestId('space-menu-show-spaces')).not.toBeNull());
        expect(menuIds(screen)).toEqual(expect.arrayContaining(['space-menu:a', 'space-menu-edit', 'space-menu-manage']));
        await screen.pressByTestIdAsync('space-menu-show-spaces');
        await vi.waitFor(() => expect(onSetSpacesEnabled).toHaveBeenCalledWith(false));
    });

    it('when spaces are off offers only Filter and the way back, which turns them on', async () => {
        const onSetSpacesEnabled = vi.fn();
        const screen = await renderScreen(<Host scope="account-a" spacesEnabled={false} onSetSpacesEnabled={onSetSpacesEnabled} />);
        await screen.pressByTestIdAsync('space-title');
        await vi.waitFor(() => expect(screen.findByTestId('space-menu-show-spaces')).not.toBeNull());
        expect(menuIds(screen).filter(id => !id.startsWith('space-menu-show-spaces'))).toEqual(['space-menu-filter']);
        await screen.pressByTestIdAsync('space-menu-show-spaces');
        await vi.waitFor(() => expect(onSetSpacesEnabled).toHaveBeenCalledWith(true));
    });

    it('offers no switch before the Account\'s spaces are known', async () => {
        const screen = await renderScreen(<Host scope="account-a" spacesEnabled={null} />);
        await screen.pressByTestIdAsync('space-title');
        await vi.waitFor(() => expect(screen.findByTestId('space-menu-filter')).not.toBeNull());
        expect(screen.findByTestId('space-menu-show-spaces')).toBeNull();
    });
});

describe('built-in controlled space selection', () => {
    it('withdraws the open picker when its captured Account catalog changes', async () => {
        const screen = await renderScreen(<Host scope="account-a" />);
        await screen.pressByTestIdAsync('space-title');
        await vi.waitFor(() => expect(screen.findByTestId('space-menu:a')).not.toBeNull());
        await screen.update(<Host scope="account-b" />);
        expect(screen.findByTestId('space-menu:b')).toBeNull();
        await screen.pressByTestIdAsync('space-title');
        await vi.waitFor(() => expect(screen.findByTestId('space-menu:b')).not.toBeNull());
    });
});

describe('the list\'s common filters in the title menu', () => {
    function FacetHost() {
        const [needsYou, setNeedsYou] = React.useState(false);
        return <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
            <CollectionSpaceTitle scope="account-a" testIDPrefix="space" entityKind="sessionWork" label="My work"
                spaces={[{ ...base, id: 'a', name: 'My work' }]} spacesEnabled onSetSpacesEnabled={() => {}}
                selectedSpaceId="a" modified={needsYou} onSelectSpace={() => {}}
                facets={[
                    { id: 'needs-you', label: 'Needs you', valueLabel: 'Needs you', selected: needsYou, onToggle: () => setNeedsYou((on) => !on) },
                    { id: 'failed', label: 'Failed', valueLabel: 'Failed', selected: false, onToggle: () => {} },
                ]}
                onOpenFilter={() => {}} onSaveAs={() => {}} onSaveChanges={() => {}} onEdit={() => {}} />
        </HappierUiPlatformProvider>;
    }

    it('toggles a common filter in one press from the menu, which stays open for the next one', async () => {
        const screen = await renderScreen(<FacetHost />);
        await screen.pressByTestIdAsync('space-title');
        await vi.waitFor(() => expect(screen.findByTestId('space-menu-facet:needs-you')).not.toBeNull());
        expect(menuIds(screen)).toEqual(expect.arrayContaining(['space-menu-facet:needs-you', 'space-menu-facet:failed', 'space-menu-filter']));
        await screen.pressByTestIdAsync('space-menu-facet:needs-you');
        // Still open, and the row now says the filter is on.
        await vi.waitFor(() => expect(screen.findByTestId('space-menu-save-as')).not.toBeNull());
        expect(screen.findByTestId('space-menu-facet:needs-you')).not.toBeNull();
        expect(screen.tree.findAll((node) => node.props.testID === 'space-menu-facet:needs-you'
            && (node.props.accessibilityState?.checked === true || node.props['aria-checked'] === true)).length).toBeGreaterThan(0);
    });
});
