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
                            requestClose('selection');
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

    // Owner 19:16 item 01: the Project Look sheet opened inside the page's popover scope and was hosted there,
    // under the shell's floating header and tab bar, which took its close and drag. A sheet is a screen surface:
    // it is hosted by the screen's (or its dialog's) overlay layer, never by a page-local popover scope.
    it('hosts a sheet opened inside a page popover scope at the screen overlay layer', async () => {
        const { PopoverScope } = await import('./PopoverScope');
        const screen = await renderScreen(<OverlayPortalProvider>
            <View testID="page">
                <PopoverScope>
                    <Popover open phonePresentation="sheet" accessibilityLabel="Look" onRequestClose={() => {}}>
                        {() => <View testID="look-sheet-content" />}
                    </Popover>
                </PopoverScope>
            </View>
            <View testID="screen-overlay-host"><OverlayPortalHost /></View>
        </OverlayPortalProvider>);
        expect(screen.findByTestId('page')!.findAllByProps({ testID: 'look-sheet-content' })).toHaveLength(0);
        expect(screen.findByTestId('screen-overlay-host')!.findAllByProps({ testID: 'look-sheet-content' }).length).toBeGreaterThan(0);
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

    // Native QA 11-09 (R2): a View options panel taller than either side of its trigger slid up over the trigger
    // row. A phone panel takes the side with more room, capped at it, and scrolls; it never covers its trigger.
    it('opens a tall phone panel on its roomier side, capped there, instead of sliding over its trigger', async () => {
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');
        const { flushHookEffects } = await import('@/dev/testkit/hooks/flushHookEffects');
        const portalRootNode = {
            measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(0, 0, 390, 844),
            measure: (cb: (...args: number[]) => void) => cb(0, 0, 390, 844, 0, 0),
        };
        let renderedBounds: PopoverRenderProps | undefined;
        await renderScreen(
            <PopoverPortalTargetContextProvider value={{ rootRef: { current: portalRootNode as never }, layout: { width: 390, height: 844 } }}>
                <OverlayPortalProvider>
                    <Popover open phonePresentation="panel" fit="shift" maxHeightCap={700} placement="bottom" gap={8}
                        backdrop={false} portal={{ native: true }}
                        anchor={{ kind: 'rect', rect: { left: 330, top: 300, width: 40, height: 40 } }}
                        accessibilityLabel="View options" onRequestClose={() => {}}>
                        {(bounds) => {
                            renderedBounds = bounds;
                            return <FloatingOverlay maxHeight={bounds.maxHeight}><View testID="panel-content" /></FloatingOverlay>;
                        }}
                    </Popover>
                    <OverlayPortalHost />
                </OverlayPortalProvider>
            </PopoverPortalTargetContextProvider>,
        );
        await act(async () => {
            await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
        });
        expect(renderedBounds?.placement).toBe('bottom');
        // Below the trigger the window leaves at most 844 - 340 - 8; the panel's height stays within it.
        expect(renderedBounds?.maxHeight).toBeGreaterThan(0);
        expect(renderedBounds?.maxHeight).toBeLessThanOrEqual(844 - 340 - 8);
    });

    // Owner 19:16 item 01: every popover stops below the top safe area (the status bar), whatever room it has.
    it('stops a popover opened upward below the top safe area of a screen-level portal', async () => {
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');
        const { flushHookEffects } = await import('@/dev/testkit/hooks/flushHookEffects');
        const portalRootNode = {
            measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(0, 0, 390, 844),
            measure: (cb: (...args: number[]) => void) => cb(0, 0, 390, 844, 0, 0),
        };
        let renderedBounds: PopoverRenderProps | undefined;
        await renderScreen(
            <PopoverPortalTargetContextProvider value={{ rootRef: { current: portalRootNode as never }, layout: { width: 390, height: 844 } }}>
                <OverlayPortalProvider>
                    <Popover open phonePresentation="panel" placement="top" gap={8} backdrop={false} portal={{ native: true }}
                        anchor={{ kind: 'rect', rect: { left: 20, top: 700, width: 120, height: 32 } }}
                        accessibilityLabel="This Home" onRequestClose={() => {}}>
                        {(bounds) => {
                            renderedBounds = bounds;
                            return <FloatingOverlay maxHeight={bounds.maxHeight}><View testID="panel-content" /></FloatingOverlay>;
                        }}
                    </Popover>
                    <OverlayPortalHost />
                </OverlayPortalProvider>
            </PopoverPortalTargetContextProvider>,
        );
        await act(async () => {
            await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
        });
        expect(renderedBounds?.placement).toBe('top');
        // Above the trigger: 700 - 8, less the 24 status bar the safe area reports.
        expect(renderedBounds?.maxHeight).toBe(700 - 8 - 24);
    });

    // SESSION-PHONE 21:50: a Session header menu opened invisibly from a paged pane. A phone panel spans its
    // boundary from the boundary's left edge; with a portal root wider than the screen and scrolled to its second
    // page, that edge is off the screen, so the panel was placed (and its backdrop live) where nobody could see it.
    // A placement stays on the part of the portal root the screen shows.
    it('keeps a phone panel on screen under its trigger when its portal root runs past the screen (a paged pane)', async () => {
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');
        const { flushHookEffects } = await import('@/dev/testkit/hooks/flushHookEffects');
        const { flattenTestStyle, findPopoverContentView } = await import('@/dev/testkit/harness/popoverHarness');
        // Two pages side by side, moved one page left: the second is on screen.
        const portalRootNode = {
            measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(-390, 0, 780, 844),
            measure: (cb: (...args: number[]) => void) => cb(0, 0, 780, 844, -390, 0),
        };
        const anchorNode = {
            measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(330, 100, 40, 40),
            measureLayout: (_root: unknown, onSuccess: (x: number, y: number, w: number, h: number) => void) => onSuccess(720, 100, 40, 40),
        };
        let renderedBounds: PopoverRenderProps | undefined;
        const screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={{ rootRef: { current: portalRootNode as never }, layout: { width: 780, height: 844 } }}>
                <OverlayPortalProvider>
                    <Popover open phonePresentation="panel" placement="bottom" gap={8} backdrop={false}
                        portal={{ native: true, anchorAlign: 'start' }} anchorRef={{ current: anchorNode as never }}
                        accessibilityLabel="Session" onRequestClose={() => {}}>
                        {(bounds) => {
                            renderedBounds = bounds;
                            return React.createElement('PopoverChild');
                        }}
                    </Popover>
                    <OverlayPortalHost />
                </OverlayPortalProvider>
            </PopoverPortalTargetContextProvider>,
        );
        await act(async () => {
            await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
        });
        const style = flattenTestStyle(findPopoverContentView(screen)?.props?.style);
        const outset = Number(style.paddingTop ?? 0);
        // The panel's surface in window space: the root starts 390 left of the screen.
        const windowLeft = Number(style.left) + outset - 390;
        const surfaceWidth = Number(style.width) - outset * 2;
        expect(renderedBounds?.placement).toBe('bottom');
        expect(Number(style.top) + outset).toBe(148);
        // The whole panel stands on the screen's 390, within its gutters.
        expect(windowLeft).toBeGreaterThanOrEqual(0);
        expect(windowLeft + surfaceWidth).toBeLessThanOrEqual(390);
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

    it('pushes a picker opened inside a pushed view over it, and its Back returns to that view', async () => {
        function Menu() {
            const [picker, setPicker] = React.useState(false);
            const [deep, setDeep] = React.useState(false);
            return <Popover open phonePresentation="panel" accessibilityLabel="Add" onRequestClose={() => {}}>
                {() => <FloatingOverlay>
                    <RoundButton testID="menu-row" title="Send to" onPress={() => setPicker(true)} />
                    {picker ? <Popover open phonePresentation="panel" accessibilityLabel="Send to" onRequestClose={() => setPicker(false)}>
                        {() => <FloatingOverlay>
                            <RoundButton testID="picker-row" title="A model" onPress={() => setDeep(true)} />
                            {deep ? <Popover open phonePresentation="panel" accessibilityLabel="A model" onRequestClose={() => setDeep(false)}>
                                {() => <FloatingOverlay><RoundButton testID="deep-choice" title="Use" onPress={() => {}} /></FloatingOverlay>}
                            </Popover> : null}
                        </FloatingOverlay>}
                    </Popover> : null}
                </FloatingOverlay>}
            </Popover>;
        }
        const screen = await renderScreen(<Menu />);
        await screen.pressByTestIdAsync('menu-row');
        await screen.pressByTestIdAsync('picker-row');

        // The deeper picker shows, named beside one Back; the view it came from stays mounted under it.
        expect(screen.findByTestId('deep-choice')).not.toBeNull();
        expect(screen.getTextContent()).toContain('A model');
        const backs = screen.findAllByProps({ testID: 'popover-push.back' });
        await act(async () => { backs[backs.length - 1]!.props.onPress?.(); });
        expect(screen.findByTestId('deep-choice')).toBeNull();
        expect(screen.findByTestId('picker-row')).not.toBeNull();
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
