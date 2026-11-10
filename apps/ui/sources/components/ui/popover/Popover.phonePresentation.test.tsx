import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';
import type { PopoverRenderProps } from './_types';

const viewport = vi.hoisted(() => ({ width: 390, height: 844 }));

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => viewport,
            Dimensions: { get: () => ({ ...viewport, scale: 1, fontScale: 1 }) },
        });
    },
});

// Safe-area measurements come from the device SDK; overlay policy remains real.
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 34, left: 0 }),
    initialWindowMetrics: null,
}));

// Collect the real UI graph before the behavior deadline, as in the adjacent DOM suites.
const { Popover } = await import('./Popover');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay');
const { View } = await import('react-native');
const { Text } = await import('@/components/ui/text/Text');
const { t } = await import('@/text');
const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');

afterEach(() => { viewport.width = 390; viewport.height = 844; });

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
    return typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('Popover phone presentation', () => {
    it('hosts a composer sheet at the screen boundary so its choices and outside dismissal remain reachable', async () => {
        const selected = vi.fn();
        function Composer() {
            const [open, setOpen] = React.useState(true);
            return <OverlayPortalProvider>
                <View testID="composer-card">
                    <RoundButton testID="open-sheet" title="Actions" onPress={() => setOpen(true)} />
                    <Popover open={open} phonePresentation="sheet" accessibilityLabel="Actions"
                        onRequestClose={() => setOpen(false)}>
                        {({ requestClose }) => <RoundButton testID="select-profile" title="Profile" onPress={() => {
                            selected();
                            requestClose();
                        }} />}
                    </Popover>
                </View>
                <View testID="screen-overlay-host"><OverlayPortalHost /></View>
            </OverlayPortalProvider>;
        }
        const screen = await renderScreen(<Composer />);
        const card = screen.findByTestId('composer-card')!;
        const host = screen.findByTestId('screen-overlay-host')!;
        // UIKit rejects hits outside the native parent's bounds even when overflow is visible.
        expect(card.findAllByProps({ testID: 'select-profile' })).toHaveLength(0);
        expect(host.findAllByProps({ testID: 'select-profile' }).length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('select-profile');
        expect(selected).toHaveBeenCalledOnce();
        expect(host.findAll(node => node.props.role === 'dialog' && node.props.accessibilityViewIsModal === true)).toHaveLength(0);

        await screen.pressByTestIdAsync('open-sheet');
        const backdrop = host.findAllByType('TouchableWithoutFeedback')[0];
        expect(backdrop).toBeTruthy();
        await act(async () => { backdrop!.props.onPress(); });
        expect(host.findAll(node => node.props.role === 'dialog' && node.props.accessibilityViewIsModal === true)).toHaveLength(0);
    });

    it('keeps long plain sheet content reachable through the frame body scroller', async () => {
        viewport.height = 360;
        const recover = vi.fn();
        const screen = await renderScreen(
            <Popover open phonePresentation="sheet" sheetHeader="none" accessibilityLabel="Voice"
                onRequestClose={() => {}}>
                {() => <View testID="recovery-content">
                    <Text>{'Check the selected speech provider and its account credentials before trying again.\n'.repeat(20)}</Text>
                    <RoundButton testID="recovery-action" title="Try again" onPress={recover} />
                </View>}
            </Popover>,
        );

        const scroller = screen.findByTestId('modal-card-body-scroll');
        expect(scroller?.props.scrollEnabled).toBe(true);
        expect(scroller?.findAllByProps({ testID: 'recovery-action' }).length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('recovery-action');
        expect(recover).toHaveBeenCalledOnce();
    });

    it('uses a form completion action as the single sheet header exit', async () => {
        const onComplete = vi.fn();
        const onClose = vi.fn();
        const screen = await renderScreen(<Popover open phonePresentation="sheet" accessibilityLabel="Trigger"
            sheetHeaderAction={<RoundButton testID="sheet-done" size="small" title="Done" onPress={onComplete} />}
            onRequestClose={onClose}>{() => React.createElement('Form')}</Popover>);
        expect(screen.findByTestId('popover-sheet.close')).toBeNull();
        await screen.pressByTestIdAsync('sheet-done');
        expect(onComplete).toHaveBeenCalledOnce();
        expect(onClose).not.toHaveBeenCalled();
    });
    it('presents content as a named, full-width sheet with the shared close action on a phone', async () => {
        const onClose = vi.fn();
        let renderedBounds: PopoverRenderProps | undefined;
        const screen = await renderScreen(
            <Popover
                open
                phonePresentation="sheet"
                accessibilityLabel="Board settings"
                maxWidthCap={400}
                maxHeightCap={640}
                onRequestClose={onClose}
            >
                {(bounds) => {
                    renderedBounds = bounds;
                    return <FloatingOverlay maxHeight={bounds.maxHeight}>
                        <View testID="sheet-content" />
                    </FloatingOverlay>;
                }}
            </Popover>,
        );

        const dialog = screen.findAll((node) => node.props.role === 'dialog')[0];
        expect(dialog?.props.accessibilityLabel).toBe('Board settings');
        expect(dialog?.props.accessibilityViewIsModal).toBe(true);
        expect(renderedBounds?.maxWidth).toBe(390);
        expect(Boolean(screen.findByTestId('sheet-content'))).toBe(true);
        expect(screen.findByTestId('modal-card-body-scroll')?.props.scrollEnabled).toBe(true);
        expect(screen.findAllByType('Animated.ScrollView').some(node =>
            node.props.scrollEnabled !== false
            && node.findAllByProps({ testID: 'sheet-content' }).length > 0,
        )).toBe(true);
        await screen.pressByTestIdAsync('popover-sheet.close');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('lets content that carries its own header own the sheet top, closing by the grabber', async () => {
        const onClose = vi.fn();
        const screen = await renderScreen(
            <Popover open phonePresentation="sheet" sheetHeader="none" sheetMaterial="solid"
                accessibilityLabel="Voice" onRequestClose={onClose}>
                {(bounds) => React.createElement('GlanceContent', { presentation: bounds.presentation })}
            </Popover>,
        );

        const dialog = screen.findAll((node) => node.props.role === 'dialog')[0];
        expect(dialog?.props.accessibilityLabel).toBe('Voice');
        // One title and one close affordance: the content's own header, the sheet's grabber.
        expect(screen.findByTestId('popover-sheet.close')).toBeNull();
        expect(screen.getTextContent()).not.toContain('Voice');
        expect(screen.findByType('GlanceContent')?.props.presentation).toBe('sheet');
        const grabber = screen.findAll((node) => node.props.accessibilityRole === 'button'
            && node.props.accessibilityLabel === t('common.close') && typeof node.props.onAccessibilityAction === 'function')[0];
        expect(grabber).toBeTruthy();
        grabber!.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('pushes a sheet popover opened from inside a phone sheet into that sheet, with a Back that returns to it', async () => {
        const parentClose = vi.fn();
        function Menu() {
            const [open, setOpen] = React.useState(true);
            const [picker, setPicker] = React.useState(false);
            return <Popover open={open} phonePresentation="sheet" sheetHeader="none" accessibilityLabel="Add"
                onRequestClose={() => { parentClose(); setOpen(false); }}>
                {() => <View>
                    <RoundButton testID="menu-row" title="Session type" onPress={() => setPicker(true)} />
                    {picker ? <Popover open phonePresentation="sheet" accessibilityLabel="Session type"
                        onRequestClose={() => setPicker(false)}>
                        {() => <RoundButton testID="picker-choice" title="Direct" onPress={() => { setPicker(false); setOpen(false); }} />}
                    </Popover> : null}
                </View>}
            </Popover>;
        }
        const modalSheets = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
            screen.findAll((node) => node.props.role === 'dialog' && node.props.accessibilityViewIsModal === true);
        const screen = await renderScreen(<Menu />);
        await screen.pressByTestIdAsync('menu-row');

        // One sheet: the picker replaces the menu inside it, named, with a Back control.
        expect(modalSheets(screen)).toHaveLength(1);
        expect(screen.findByTestId('picker-choice')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Session type');
        expect(screen.findByTestId('popover-sheet.back')).toBeTruthy();

        // Back pops to the menu without closing the sheet: the picker slides out, then is gone.
        await screen.pressByTestIdAsync('popover-sheet.back');
        expect(modalSheets(screen)).toHaveLength(1);
        expect(screen.findByTestId('popover-sheet.back')).toBeNull();
        expect(screen.findByTestId('popover-sheet.push-exit-layer')?.findAllByProps({ testID: 'picker-choice' }).length).toBeGreaterThan(0);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
        expect(screen.findByTestId('picker-choice')).toBeNull();
        expect(parentClose).not.toHaveBeenCalled();

        // A choice closes the whole sheet.
        await screen.pressByTestIdAsync('menu-row');
        await screen.pressByTestIdAsync('picker-choice');
        expect(modalSheets(screen)).toHaveLength(0);
    });

    it('closes a sheet when the page it was opened from stops being presented, and does not reopen on return', async () => {
        // An Open inside a composer sheet shows the opened detail in place: the composer's page is retained
        // but no longer presented, and the sheet must not stay over the detail.
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const closes = vi.fn();
        function Composer() {
            const [open, setOpen] = React.useState(true);
            return <Popover open={open} phonePresentation="sheet" accessibilityLabel="Pull request"
                onRequestClose={() => { closes(); setOpen(false); }}>
                {() => <Text>glance</Text>}
            </Popover>;
        }
        let present: (presented: boolean) => void = () => {};
        function Page() {
            const [presented, setPresented] = React.useState(true);
            present = setPresented;
            return <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>
                <Composer />
            </PluginSurfaceFocusEligibilityProvider>;
        }
        const modalSheets = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
            screen.findAll((node) => node.props.role === 'dialog' && node.props.accessibilityViewIsModal === true);
        const screen = await renderScreen(<Page />);
        expect(modalSheets(screen).length).toBeGreaterThan(0);

        await act(async () => { present(false); });
        expect(closes).toHaveBeenCalledOnce();
        expect(modalSheets(screen)).toHaveLength(0);

        await act(async () => { present(true); });
        expect(modalSheets(screen)).toHaveLength(0);
    });

    it('stops presenting the sheet while its page is withdrawn even when the opener cannot commit its close yet', async () => {
        // Live READY161 (390): the composer's retained page is frozen behind the opened detail, so its close never
        // commits; the sheet stayed over the detail with a dead Close, Escape and backdrop (TL-C phone glance).
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const closes = vi.fn();
        let present: (presented: boolean) => void = () => {};
        function Page() {
            const [presented, setPresented] = React.useState(true);
            present = setPresented;
            return <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>
                <Popover open phonePresentation="sheet" accessibilityLabel="Pull request" onRequestClose={closes}>
                    {() => <Text>glance</Text>}
                </Popover>
            </PluginSurfaceFocusEligibilityProvider>;
        }
        const modalSheets = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
            screen.findAll((node) => node.props.role === 'dialog' && node.props.accessibilityViewIsModal === true);
        const screen = await renderScreen(<Page />);
        expect(modalSheets(screen).length).toBeGreaterThan(0);
        await act(async () => { present(false); });
        expect(closes).toHaveBeenCalled();
        expect(modalSheets(screen)).toHaveLength(0);
    });

    it('anchors a phone panel to its trigger, spanning the screen less its gutters, never as a sheet (owner R2)', async () => {
        let renderedBounds: PopoverRenderProps | undefined;
        const screen = await renderScreen(
            <Popover open phonePresentation="panel" accessibilityLabel="Model" maxWidthCap={300}
                onRequestClose={() => {}}>
                {(bounds) => {
                    renderedBounds = bounds;
                    return <FloatingOverlay maxHeight={bounds.maxHeight}><View testID="panel-content" /></FloatingOverlay>;
                }}
            </Popover>,
        );

        expect(screen.findAll((node) => node.props.role === 'dialog')).toHaveLength(0);
        expect(screen.findByTestId('popover-sheet.close')).toBeNull();
        expect(Boolean(screen.findByTestId('panel-content'))).toBe(true);
        expect(renderedBounds?.presentation).not.toBe('sheet');
        // The caller's desktop width does not hold on a phone: the panel takes the screen less its gutters.
        expect(renderedBounds?.maxWidth).toBeGreaterThan(300);
        expect(renderedBounds?.maxWidth).toBeLessThanOrEqual(390);
    });

    // NATIVE-SWEEP-1110 L10: a draft's ⋯ asked for `left` and stayed a narrow menu beside its trigger (native: at
    // the top of the screen). A phone panel opens above or below its trigger whatever side its caller named.
    it.each(['left', 'right', 'auto-horizontal'] as const)('opens a %s-placed phone panel above or below its trigger', async (placement) => {
        let renderedBounds: PopoverRenderProps | undefined;
        await renderScreen(
            <Popover open phonePresentation="panel" placement={placement} accessibilityLabel="Draft" onRequestClose={() => {}}>
                {(bounds) => {
                    renderedBounds = bounds;
                    return <FloatingOverlay maxHeight={bounds.maxHeight}><View testID="panel-content" /></FloatingOverlay>;
                }}
            </Popover>,
        );
        expect(['top', 'bottom']).toContain(renderedBounds?.placement);
    });

    // NATIVE-SWEEP-1110 L10: a plain menu (cockpit More, a draft's ⋯) kept its desktop width, or opened left of a
    // trigger near the bottom and landed at the top of the screen. Every phone menu is the anchored panel.
    it('opens a plain menu on a phone as the anchored panel, never at its desktop width or beside its trigger', async () => {
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const screen = await renderScreen(
            <DropdownMenu open onOpenChange={() => {}} placement="left" matchTriggerWidth={false} maxWidthCap={220}
                items={[{ id: 'delete', title: 'Delete draft' }]} onSelect={() => {}}
                trigger={({ toggle }) => <RoundButton testID="menu-trigger" title="More" onPress={toggle} />} />,
        );
        expect(screen.findByType(Popover).props.phonePresentation).toBe('panel');
    });

    it('pushes a submenu opened inside a phone panel into it in place, with a Back that returns to it', async () => {
        const parentClose = vi.fn();
        function Menu() {
            const [open, setOpen] = React.useState(true);
            const [picker, setPicker] = React.useState(false);
            return <Popover open={open} phonePresentation="panel" accessibilityLabel="Add"
                onRequestClose={() => { parentClose(); setOpen(false); }}>
                {() => <FloatingOverlay>
                    <RoundButton testID="menu-row" title="Session type" onPress={() => setPicker(true)} />
                    {picker ? <Popover open phonePresentation="panel" accessibilityLabel="Session type"
                        onRequestClose={() => setPicker(false)}>
                        {() => <FloatingOverlay>
                            <RoundButton testID="picker-choice" title="Direct" onPress={() => { setPicker(false); setOpen(false); }} />
                        </FloatingOverlay>}
                    </Popover> : null}
                </FloatingOverlay>}
            </Popover>;
        }
        const screen = await renderScreen(<Menu />);
        await screen.pressByTestIdAsync('menu-row');

        // No sheet and no second popover: the picker replaces the menu's content, named beside its Back.
        expect(screen.findAll((node) => node.props.role === 'dialog')).toHaveLength(0);
        expect(screen.findByTestId('popover-push.view')?.findAllByProps({ testID: 'picker-choice' }).length).toBeGreaterThan(0);
        expect(screen.findByTestId('popover-push.view')?.findAllByProps({ testID: 'popover-push.back' }).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).toContain('Session type');

        await screen.pressByTestIdAsync('popover-push.back');
        expect(screen.findByTestId('popover-push.view')).toBeNull();
        expect(screen.findByTestId('picker-choice')).toBeNull();
        expect(parentClose).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('menu-row');
        await screen.pressByTestIdAsync('picker-choice');
        // A choice closes the whole popover (after its exit motion).
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
        expect(screen.findByTestId('menu-row')).toBeNull();
        expect(screen.findByTestId('picker-choice')).toBeNull();
    });

    // Native QA (PHONE-POPOVERS-1109, iOS 26.4): a root popover's glass stayed clear while a view pushed into it
    // later was frosted. UIKit renders no visual effect created under an ancestor with alpha < 1, and the
    // popover was hidden by opacity while it measured, then faded in.
    it('never hides or fades a native popover\'s material through opacity on its ancestors', async () => {
        const opacityAncestors = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
            const child = screen.findByType('PopoverChild' as never);
            const found: unknown[] = [];
            for (let node = child?.parent ?? null; node; node = node.parent) {
                const flat = flattenStyle(node.props?.style);
                if ('opacity' in flat && flat.opacity !== 1) found.push(flat.opacity);
            }
            return found;
        };
        function Anchored() {
            const anchorRef = React.useRef<React.ElementRef<typeof View>>(null);
            return <OverlayPortalProvider>
                <View ref={anchorRef} collapsable={false}><Text>Home</Text></View>
                <Popover open anchorRef={anchorRef} phonePresentation="panel" portal={{ native: true }} onRequestClose={() => {}}>
                    {() => React.createElement('PopoverChild')}
                </Popover>
                <OverlayPortalHost />
            </OverlayPortalProvider>;
        }
        const screen = await renderScreen(<Anchored />);
        expect(screen.findByType('PopoverChild' as never)).toBeTruthy();
        expect(opacityAncestors(screen)).toEqual([]);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
        expect(opacityAncestors(screen)).toEqual([]);
    });

    it('keeps the anchored presentation on a wide viewport when phone sheets are requested', async () => {
        viewport.width = 1200;
        viewport.height = 900;
        const screen = await renderScreen(
            <Popover open phonePresentation="sheet" onRequestClose={() => {}}>
                {() => React.createElement('PopoverChild')}
            </Popover>,
        );

        expect(screen.findAll((node) => node.props.role === 'dialog').length).toBe(0);
        expect(Boolean(screen.findByType('PopoverChild'))).toBe(true);
    });
});
