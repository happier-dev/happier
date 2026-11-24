import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The navigator is the boundary: the screen's navigation object, through the canonical router mock.
const setOptions = vi.fn();
// A settings collection's detail stack hides its own header; the visible one is its parent's.
const parentSetOptions = vi.fn();
const router = createExpoRouterMock();
installSettingsViewCommonModuleMocks({ router: () => router.module });
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

const { PageHeader, NavigationTitleChromeProvider } = await import('@/components/ui/layout/PageHeader');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { Stack } = await import('@/components/appShell/workspace/destinationRoute');
const { NavigationHeaderActions } = await import('@/components/ui/layout/NavigationHeaderActions');
const { PageHeaderMenu } = await import('@/components/ui/layout/PageHeaderEntityParts');
const { SelectableRow } = await import('@/components/ui/lists/SelectableRow');
const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');
const { Pressable, View } = await import('react-native');
const { PageHeader: PluginPageHeader } = await import('../../../../../../../packages/plugin-ui/src/components/PageHeader');
const { Button: PluginButton } = await import('../../../../../../../packages/plugin-ui/src/components/Button');
const { PluginUiProviderInternal } = await import('../../../../../../../packages/plugin-ui/src/components/PluginUiProvider');
const { createHostApiStub, createSurfaceContext } = await import('../../../../../../../packages/plugin-ui/src/surfaceFixture.testSupport');
const { useNavigationTitleChromeShowsTitle } = await import('@/components/ui/layout/navigationTitleChrome');
const { createPluginUiPrivatePresentationHost } = await import('@/components/plugins/surfaces/pluginUiPrivatePresentationHost');

beforeEach(() => {
    setOptions.mockReset();
    parentSetOptions.mockReset();
});

function header(nativeTitle: boolean, onPress: () => void, inNavigator = true) {
    const page = (
        <NavigationTitleChromeProvider showsTitle={nativeTitle}>
            <PageHeader
                testID="pool-header"
                title="New machine pool"
                description="Sessions try the preferred machine first."
                primaryAction={{ title: 'Create pool', onPress, testID: 'pool-create' }}
                actions={React.createElement('Chip')}
            />
        </NavigationTitleChromeProvider>
    );
    (router.state as { navigation: unknown }).navigation = inNavigator
        ? { setOptions, getParent: () => ({ setOptions: parentSetOptions }) }
        : null;
    return page;
}

function lastHeaderRight(): ReactTestInstance | null {
    const options = setOptions.mock.calls.map((call) => call[0] as { headerRight?: () => React.ReactNode }).filter((o) => 'headerRight' in o);
    const render = options.at(-1)?.headerRight;
    return render ? (render() as unknown as ReactTestInstance) : null;
}

async function openContextActions(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await screen.pressByTestIdAsync('page-header-actions.trigger');
    // DropdownMenu defers opening until the current press has finished at the event-loop boundary.
    await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
}

describe('PageHeader primary action placement', () => {
    // Owner 2026-11-10 (Artifacts Save): iOS 26 backs a bar's custom items with shared glass, so a Happier button
    // there wore two chromes. The page's actions carry their own chrome and hide that backing.
    it('publishes the phone actions as an iOS bar item without the shared glass backing', async () => {
        await renderScreen(header(true, () => {}));
        type Items = (props: { tintColor?: string; canGoBack: boolean }) => readonly Readonly<{ type: string; element?: React.ReactElement; hidesSharedBackground?: boolean }>[];
        const published = setOptions.mock.calls.map((call) => call[0] as { unstable_headerRightItems?: Items }).filter((o) => o.unstable_headerRightItems);
        const items = published.at(-1)?.unstable_headerRightItems?.({ canGoBack: true });
        expect(items).toHaveLength(1);
        expect(items![0]!.type).toBe('custom');
        expect(items![0]!.hidesSharedBackground).toBe(true);
        const screen = await renderScreen(items![0]!.element!);
        expect(screen.findHostByTestId('pool-create')).not.toBeNull();
    });

    it('folds entity operations and sibling controls into one working phone menu', async () => {
        const share = vi.fn();
        const render = (phone: boolean) => <DestinationInstanceHost tabId="role" ref={{ kind: 'settings', params: {} }}
            pathname="/settings" focused visible phone={phone}
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <PageHeader title="Role" actions={<View>
                <button data-testid="role-enabled">Enabled</button>
                <PageHeaderMenu testID="role-menu" actions={[{ id: 'share', title: 'Share', onSelect: share }]} />
            </View>} />
        </DestinationInstanceHost>;
        const screen = await renderScreen(render(true));
        await openContextActions(screen);
        expect(screen.root.findAllByProps({ 'data-testid': 'role-enabled' })).toHaveLength(1);
        const operation = screen.findAllByType(SelectableRow as never).find(node => node.props.title === 'Share');
        expect(operation, 'Share is directly available after opening overflow once').toBeDefined();
        await act(async () => {
            operation!.props.onPress();
            await new Promise<void>(resolve => setTimeout(resolve, 150));
        });
        expect(share).toHaveBeenCalledOnce();
        await screen.update(render(false));
        expect(screen.findHostByTestId('role-menu.trigger')).not.toBeNull();
    });
    it('folds public plugin actions through the host navigation producer and returns them to the body on resize', async () => {
        const action = vi.fn();
        const remove = vi.fn();
        const context = createSurfaceContext({ translations: { 'channels.link': 'Link a conversation' } });
        const hostApi = createHostApiStub(context);
        function PluginPage(props: Readonly<{ pending: boolean }>) {
            const showsTitle = useNavigationTitleChromeShowsTitle();
            const pageChrome = { showsTitle, renderNavigationActions: (actions: React.ReactNode) =>
                showsTitle ? <NavigationHeaderActions primary={null} actions={actions} /> : <>{actions}</> };
            return <PluginUiProviderInternal hostApi={hostApi} context={context}
                presentationHost={createPluginUiPrivatePresentationHost(undefined, { pageChrome })}>
                <PluginPageHeader title="Channels" description="Link conversations." testID="plugin-header"
                    actions={<View>
                        <PluginButton testID="plugin-remove" variant="destructive" busy={props.pending} title="Remove link" onPress={remove} />
                        <button data-testid="plugin-enabled">Enabled</button>
                        <PluginButton testID="plugin-link" variant="secondary" title="Link" titleKey="channels.link"
                            accessibilityLabel="Open the conversation linker" onPress={action} />
                    </View>} />
            </PluginUiProviderInternal>;
        }
        const render = (phone: boolean, pending = true) => <DestinationInstanceHost tabId="plugin" ref={{ kind: 'settings', params: {} }}
            pathname="/settings" focused visible phone={phone}
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}><PluginPage pending={pending} /></DestinationInstanceHost>;
        const screen = await renderScreen(render(false));
        expect(screen.findHostByTestId('plugin-link')).not.toBeNull();
        await screen.update(render(true));
        expect(screen.findHostByTestId('plugin-link')).toBeNull();
        await openContextActions(screen);
        expect(screen.root.findAllByProps({ 'data-testid': 'plugin-enabled' })).toHaveLength(1);
        const rows = screen.findAllByType(SelectableRow as never);
        expect(rows.map(row => row.props.title)).toEqual(['Link a conversation', 'Remove link']);
        expect(rows.at(-1)?.props.disabled).toBe(true);
        expect(rows.at(-1)?.findAllByType(ActivitySpinner as never)).toHaveLength(1);
        expect(rows.at(-1)?.findByType(Pressable as never).props.onPress).toBeUndefined();
        expect(remove).not.toHaveBeenCalled();
        expect(screen.findAllByType(PageHeaderMenu as never).flatMap(menu => menu.props.actions)
            .find(operation => operation.id === 'plugin-remove')).toMatchObject({ destructive: true, loading: true });
        await screen.pressByTestIdAsync('plugin-link');
        // Menu operations commit after dismissal, unlike the Button previously retained in content.
        await act(async () => { await vi.waitFor(() => expect(action).toHaveBeenCalledOnce()); });
        await screen.update(render(true, false));
        await openContextActions(screen);
        const enabledRemove = screen.findAllByType(SelectableRow as never).find(row => row.props.title === 'Remove link');
        expect(enabledRemove?.props.disabled).not.toBe(true);
        expect(enabledRemove?.findAllByType(ActivitySpinner as never)).toHaveLength(0);
        await screen.pressByTestIdAsync('plugin-remove');
        await act(async () => { await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce()); });
        await screen.update(render(false, false));
        expect(screen.findHostByTestId('workspace-destination-header')).toBeNull();
        expect(screen.findHostByTestId('plugin-link')).not.toBeNull();
    });
    it('renders route-declared chrome in its retained destination rather than dropping its header action', async () => {
        const screen = await renderScreen(<DestinationInstanceHost tabId="route" ref={{ kind: 'settings', params: {} }}
            pathname="/settings" focused visible phone navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <Stack.Screen options={{ title: 'Route title', headerRight: () => <button data-testid="route-action">Action</button> }} />
        </DestinationInstanceHost>);
        expect(screen.root.findAllByProps({ 'data-testid': 'route-action' })).toHaveLength(1);
        expect(screen.root.findAll(node => typeof node.type === 'string' && node.props.children === 'Route title')).toHaveLength(1);
    });
    it('never lends a hidden header\'s Back as a trailing action: the page keeps one way back', async () => {
        const screen = await renderScreen(<DestinationInstanceHost tabId="hidden" ref={{ kind: 'settings', params: {} }}
            pathname="/settings/machines/m/agents" focused visible phone navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <Stack.Screen options={{ headerShown: false, headerLeft: () => <button data-testid="route-back">Back</button>,
                headerRight: () => <button data-testid="route-action">Action</button> }} />
        </DestinationInstanceHost>);
        expect(screen.root.findAllByProps({ 'data-testid': 'route-action' })).toHaveLength(1);
        expect(screen.root.findAllByProps({ 'data-testid': 'route-back' })).toHaveLength(0);
    });
    it('lets a retained draft Cancel replace collection Back and restores Back when the draft leaves', async () => {
        const cancel = vi.fn();
        function Collection(props: Readonly<{ draft: boolean }>) {
            return <>
                <Stack.Screen options={{ title: 'Collection', headerLeft: () => <button data-testid="collection-back">Back</button> }} />
                {props.draft ? <PageHeader title="New item" description="Configure an item."
                    cancelAction={{ title: 'Cancel', onPress: cancel, testID: 'retained-cancel' }} /> : null}
            </>;
        }
        const render = (draft: boolean) => <DestinationInstanceHost tabId="draft" ref={{ kind: 'settings', params: {} }}
            pathname="/settings" focused visible phone navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <Collection draft={draft} />
        </DestinationInstanceHost>;
        const screen = await renderScreen(render(true));
        expect(screen.findHostByTestId('retained-cancel')).not.toBeNull();
        expect(screen.root.findAllByProps({ 'data-testid': 'collection-back' })).toHaveLength(0);
        await screen.pressByTestIdAsync('retained-cancel');
        expect(cancel).toHaveBeenCalledOnce();
        await screen.update(render(false));
        expect(screen.root.findAllByProps({ 'data-testid': 'collection-back' })).toHaveLength(1);
    });
    it('keeps a retained web page mounted while its title, context and primary action move into phone navigation', async () => {
        const onPress = vi.fn();
        let mounts = 0;
        function Draft() {
            React.useEffect(() => { mounts++; }, []);
            const [name, setName] = React.useState('Original');
            return <>
                <PageHeader title="New machine pool" description="Sessions try the preferred machine first."
                    primaryAction={{ title: 'Create pool', onPress, testID: 'retained-pool-create' }}
                    actions={<button data-testid="retained-machine-chip">Machine</button>} />
                <input data-testid="retained-draft" value={name} onChange={(event) => setName(event.currentTarget.value)} />
            </>;
        }
        const render = (phone: boolean) => <DestinationInstanceHost tabId="pool" ref={{ kind: 'settings', params: { pageId: 'machines/pools/new' } }}
            pathname="/settings/machines/pools/new" focused visible phone={phone}
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}><Draft /></DestinationInstanceHost>;
        const screen = await renderScreen(render(false));
        await act(async () => screen.root.findByProps({ 'data-testid': 'retained-draft' }).props.onChange({ currentTarget: { value: 'Unsaved' } }));
        await screen.update(render(true));
        const chrome = screen.findHostByTestId('workspace-destination-header');
        expect(chrome).not.toBeNull();
        expect(chrome!.findAllByProps({ 'data-testid': 'retained-machine-chip' })).toHaveLength(0);
        expect(chrome!.findAll((node) => node.props.testID === 'retained-pool-create' && typeof node.props.action === 'function')).toHaveLength(1);
        await openContextActions(screen);
        expect(screen.root.findAllByProps({ 'data-testid': 'retained-machine-chip' })).toHaveLength(1);
        await screen.pressByTestIdAsync('retained-pool-create');
        expect(onPress).toHaveBeenCalledOnce();
        await screen.update(render(false));
        expect(screen.findHostByTestId('workspace-destination-header')).toBeNull();
        expect(screen.root.findByProps({ 'data-testid': 'retained-draft' }).props.value).toBe('Unsaved');
        expect(mounts).toBe(1);
    });
    it('keeps the primary action in the page on wide layouts and leaves the native header alone', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(header(false, onPress));
        expect(screen.findHostByTestId('pool-create')).not.toBeNull();
        expect(setOptions.mock.calls.some((call) => (call[0] as { headerRight?: unknown }).headerRight)).toBe(false);
        await screen.pressByTestIdAsync('pool-create');
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    // TH-VISUAL-ACCEPT-7 D8: a page whose lab draws its main action quietly on wide layouts (a preset's
    // "Create one", Home's "Invite people") put it in `actions`, so a phone folded it into "More actions".
    // The page declares it as its primary with a secondary wide presentation instead.
    it('draws a secondary primary quietly on wide layouts and keeps it the header primary on phones', async () => {
        const quiet = (showsTitle: boolean) => (
            <NavigationTitleChromeProvider showsTitle={showsTitle}>
                <PageHeader title="Preset" primaryAction={{ title: 'Create one', icon: 'plus', presentation: 'secondary',
                    onPress: () => {}, testID: 'preset-create' }} />
            </NavigationTitleChromeProvider>
        );
        (router.state as { navigation: unknown }).navigation = { setOptions, getParent: () => ({ setOptions: parentSetOptions }) };
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const wide = await renderScreen(quiet(false));
        const button = wide.findAllByType(RoundButton as never).find(node => node.props.testID === 'preset-create');
        expect(button?.props.display).toBe('secondary');
        await wide.unmount();
        const phone = await renderScreen(quiet(true));
        expect(phone.findHostByTestId('preset-create')).toBeNull();
        // The header's own control, not an entry behind "More actions".
        const inHeader = await renderScreen(lastHeaderRight() as unknown as React.ReactElement);
        expect(inHeader.findHostByTestId('preset-create')).not.toBeNull();
        expect(inHeader.findHostByTestId('page-header-actions.trigger')).toBeNull();
        // The header draws it as quietly as the page does ("Stop reviewing", U8 R7 RN3).
        expect(inHeader.findAllByType(RoundButton as never).find(node => node.props.testID === 'preset-create')?.props.display).toBe('secondary');
    });

    // One order for every page header (UI refinements 2026-11-23 22:10Z): the page's controls, then the primary, then "⋯",
    // so "⋯" keeps its place whether a primary is offered, arrives later or goes away. A page like a profile editor (a
    // machine chip, Save, and its menu) draws it the same way in the page and in the phone bar.
    it('draws the page controls, then the primary, then "⋯" last, in the page and in the phone bar', async () => {
        const page = (showsTitle: boolean) => (
            <NavigationTitleChromeProvider showsTitle={showsTitle}>
                <PageHeader title="Profile" primaryAction={{ title: 'Save', onPress: () => {}, testID: 'order-save' }}
                    actions={<View testID="order-chip" />}
                    menu={<PageHeaderMenu testID="order-menu"
                        actions={[{ id: 'delete', testID: 'order-delete', title: 'Delete', destructive: true, onSelect: () => {} }]} />} />
            </NavigationTitleChromeProvider>
        );
        (router.state as { navigation: unknown }).navigation = { setOptions, getParent: () => ({ setOptions: parentSetOptions }) };
        const positions = (tree: unknown, ids: readonly string[]) => ids.map(id => JSON.stringify(tree).indexOf(`"${id}"`));
        const wide = await renderScreen(page(false));
        const [chip, save, menu] = positions(wide.tree.toJSON(), ['order-chip', 'order-save', 'order-menu.trigger']);
        expect(chip).toBeGreaterThanOrEqual(0);
        expect(save).toBeGreaterThan(chip);
        expect(menu).toBeGreaterThan(save);
        await wide.unmount();
        const phone = await renderScreen(page(true));
        const inHeader = await renderScreen(lastHeaderRight() as unknown as React.ReactElement);
        const [barSave, barMenu] = positions(inHeader.tree.toJSON(), ['order-save', 'page-header-actions.trigger']);
        expect(barSave).toBeGreaterThanOrEqual(0);
        expect(barMenu).toBeGreaterThan(barSave);
        // The page's "⋯" rows still reach the one bar menu, beside its folded controls.
        await openContextActions(inHeader);
        expect(inHeader.findHostByTestId('order-delete')).not.toBeNull();
        expect(inHeader.findHostByTestId('order-chip')).not.toBeNull();
        await inHeader.unmount();
        await phone.unmount();
    });

    // A chooser folded into the phone "⋯" reads as one of its rows (icon, "Machine · …"), not a chip inside the menu,
    // and the row opens the chooser's own machine list, where choosing a machine selects it (UI refinements delta 11).
    it('folds the machine chooser into "⋯" as a menu row that opens its own machine list and selects from it', async () => {
        const { MachineAdministrationTargetSelector } = await import('@/components/settings/machines/MachineAdministrationTargetSelector');
        const { resolveMachineAdministrationTargetState } = await import('@/sync/domains/machines/administration/targetSelection');
        const target = { serverIdentityId: 'portable-server-b', machineId: 'machine-b' };
        const candidate = { target, displayName: 'Machine B', serverLabel: 'Server B', availability: 'online' as const,
            observation: 'live' as const, observedAt: 100 };
        const machine = { id: target.machineId, updatedAt: 100, active: true, activeAt: 100, metadataVersion: 1,
            metadata: { displayName: 'Machine B', host: 'host-b' } };
        const selectTarget = vi.fn();
        const state = resolveMachineAdministrationTargetState({ storedTarget: target, candidates: [candidate] });
        const selection = { candidates: [candidate], pickerRows: [{ candidate, serverId: 'local-profile-b', serverName: 'Server B', machine }],
            state, selectedTarget: target, selectedTargetServerMatchesActiveAccount: false, canExecute: true,
            selectTarget, clearTarget: vi.fn(), resolveExecutionTarget: () => null } as never;
        // The phone's own destination chrome draws the bar, as on a phone: the row is pressed where the person presses it.
        const screen = await renderScreen(
            <DestinationInstanceHost tabId="profile" ref={{ kind: 'settings', params: {} }} pathname="/settings" focused visible phone
                navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                <PageHeader title="Launch profile" primaryAction={{ title: 'Save', onPress: () => {}, testID: 'fold-save' }}
                    actions={<MachineAdministrationTargetSelector presentation="chip" selection={selection} testIDPrefix="fold.target" />}
                    menu={<PageHeaderMenu testID="fold-menu" actions={[{ id: 'duplicate', title: 'Duplicate', onSelect: () => {} }]} />} />
            </DestinationInstanceHost>,
        );
        try {
            await openContextActions(screen);
            // One ordinary row for the chooser, beside the page's own rows; no chip drawn inside the menu.
            const rows = screen.findAllByType(SelectableRow as never);
            expect(rows.map(row => row.props.testID)).toContain('fold.target.folded');
            const folded = rows.find(row => row.props.testID === 'fold.target.folded');
            expect(folded?.props.title).toContain('Machine B');
            // One menu, one icon column: the page's own rows carry no glyph, so neither does the chooser's; it opens its
            // sheet with the menu's own "›", as a submenu row does, never a field's "▾".
            expect(folded?.props.left ?? null).toBeNull();
            expect((folded?.props.right as React.ReactElement<{ name?: string }> | undefined)?.props.name).toBe('caret-right');
            expect(screen.findHostByTestId('fold.target.picker-list')).toBeNull();
            await screen.pressByTestIdAsync('fold.target.folded');
            // The menu runs its row after it closes; the chooser's own list then opens (a phone sheet).
            // Wait render by render: the menu's deferred row and the chooser's opening each commit on their own.
            for (let attempt = 0; attempt < 20 && screen.findHostByTestId('fold.target.picker-list') === null; attempt += 1) {
                await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 50)); });
            }
            expect(screen.findHostByTestId('fold.target.picker-list')).not.toBeNull();
            await screen.pressByTestIdAsync('fold.target.picker-option:machine-b');
            expect(selectTarget).toHaveBeenCalledWith(target);
        } finally {
            await screen.unmount();
        }
    });

    it('hands the primary action to the native header on phones instead of stacking it under the purpose', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(header(true, onPress));
        // Not in the page body.
        expect(screen.findHostByTestId('pool-create')).toBeNull();
        // In the native header, working.
        const headerRight = lastHeaderRight();
        expect(headerRight).not.toBeNull();
        const inHeader = await renderScreen(headerRight as unknown as React.ReactElement);
        await inHeader.pressByTestIdAsync('pool-create');
        expect(onPress).toHaveBeenCalledTimes(1);
        // The parent's (visible) header gets it too.
        expect(parentSetOptions.mock.calls.some((call) => typeof (call[0] as { headerRight?: unknown }).headerRight === 'function')).toBe(true);
        // Context controls share the visible navigation header on phones.
        expect(screen.root.findAllByType('Chip' as never)).toHaveLength(0);
        expect(inHeader.root.findAllByType('Chip' as never)).toHaveLength(0);
        await openContextActions(inHeader);
        expect(inHeader.root.findAllByType('Chip' as never)).toHaveLength(1);
    });

    it('moves an actions-only page to the phone header and returns it to the page on resize', async () => {
        (router.state as { navigation: unknown }).navigation = { setOptions };
        const onPress = vi.fn();
        const render = (showsTitle: boolean) => (
            <NavigationTitleChromeProvider showsTitle={showsTitle}>
                <PageHeader title="Add machine" description="Connect a computer." actions={
                    <button data-testid="discard-action" onClick={onPress}>Discard</button>
                } />
            </NavigationTitleChromeProvider>
        );
        const screen = await renderScreen(render(true));
        expect(screen.root.findAllByProps({ 'data-testid': 'discard-action' })).toHaveLength(0);
        const inHeader = await renderScreen(lastHeaderRight() as unknown as React.ReactElement);
        await openContextActions(inHeader);
        act(() => inHeader.root.findByProps({ 'data-testid': 'discard-action' }).props.onClick());
        expect(onPress).toHaveBeenCalledTimes(1);
        await act(async () => screen.tree.update(render(false)));
        expect(screen.root.findAllByProps({ 'data-testid': 'discard-action' })).toHaveLength(1);
        const last = setOptions.mock.calls.at(-1)?.[0] as { headerRight?: unknown };
        expect(last.headerRight).toBeUndefined();
    });

    it('renders outside any navigator (a preview, a plugin host) without a header to fill', async () => {
        const screen = await renderScreen(header(true, vi.fn(), false));
        expect(screen.findHostByTestId('pool-header')).not.toBeNull();
        expect(setOptions).not.toHaveBeenCalled();
    });

    it('clears the native header action when the page leaves', async () => {
        const screen = await renderScreen(header(true, vi.fn()));
        act(() => screen.tree.unmount());
        const last = setOptions.mock.calls.at(-1)?.[0] as { headerRight?: unknown };
        expect(last && 'headerRight' in last && last.headerRight === undefined).toBe(true);
    });
});
