/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const viewport = vi.hoisted(() => ({ width: 390 }));

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const nativeWeb = await vi.importActual<typeof import('react-native-web')>('react-native-web');
        const dimensions = () => ({ width: viewport.width, height: 844, scale: 1, fontScale: 1 });
        return {
            ...nativeWeb,
            // Viewport dimensions are a platform boundary; real RNW refs and focus owners run below it.
            Dimensions: {
                get: dimensions,
                addEventListener: nativeWeb.Dimensions.addEventListener.bind(nativeWeb.Dimensions),
            },
            useWindowDimensions: dimensions,
        };
    },
});

const { Popover } = await import('./Popover');
const { TextInput } = await import('@/components/ui/text/Text');
const { View, Pressable, Text } = await import('react-native');
const { FollowEditorPanel } = await import('@/components/sessions/follow/FollowEditorPanel');
const { VoiceIslandAnatomy, VoiceOrbAnatomy } = await import('@/components/voice/presence/voicePresenceAnatomy');
const { useCompanionPointerDragSession } = await import('@/components/companion/interaction/useCompanionPointerDragSession');

describe('Popover phone-sheet focus return', () => {
    it('wraps unhandled Search Tab past a programmatic-only action and preserves handled Tab', async () => {
        let completeSearch = true;
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        try {
            await act(async () => root.render(
                <Popover open phonePresentation="sheet" accessibilityLabel="Actions" onRequestClose={() => {}}>
                    {() => <>
                        <TextInput
                            accessibilityLabel="Search actions"
                            onKeyPress={event => {
                                if (completeSearch && event.nativeEvent.key === 'Tab') event.preventDefault();
                            }}
                        />
                        <button tabIndex={-1}>Programmatic-only action</button>
                    </>}
                </Popover>,
            ));
            const search = document.querySelector<HTMLInputElement>('[aria-label="Search actions"]')!;
            const close = document.querySelector('[data-testid="popover-sheet.close"]');
            const tab = () => new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
            search.focus();
            const handled = tab();
            await act(async () => { search.dispatchEvent(handled); });
            expect(handled.defaultPrevented).toBe(true);
            expect(document.activeElement).toBe(search);

            completeSearch = false;
            await act(async () => { search.dispatchEvent(tab()); });
            expect(document.activeElement).toBe(close);
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it('steps Escape back from a view pushed inside a phone sheet, keeping the sheet open', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const parentClose = vi.fn();
        let openPicker: () => void = () => {};
        function Harness() {
            const [picker, setPicker] = React.useState(false);
            openPicker = () => setPicker(true);
            return <Popover open phonePresentation="sheet" sheetHeader="none" accessibilityLabel="Add" onRequestClose={parentClose}>
                {() => <View>
                    <Text>Menu rows</Text>
                    {picker ? <Popover open phonePresentation="sheet" accessibilityLabel="Session type" onRequestClose={() => setPicker(false)}>
                        {() => <Text>Picker choices</Text>}
                    </Popover> : null}
                </View>}
            </Popover>;
        }
        try {
            await act(async () => root.render(<Harness />));
            await act(async () => openPicker());
            expect(document.querySelector('[data-testid="popover-sheet.back"]')).not.toBeNull();
            await act(async () => {
                document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            });
            expect(document.querySelector('[data-testid="popover-sheet.back"]')).toBeNull();
            expect(document.querySelector('[role="dialog"]')).not.toBeNull();
            expect(parentClose).not.toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it('dismisses an intelligence sheet through its one header Close control and restores the opener', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        function Harness() {
            const [open, setOpen] = React.useState(false);
            const anchorRef = React.useRef<import('react-native').View>(null);
            return <>
                <View ref={anchorRef}>
                    <button data-testid="intelligence-opener" onClick={() => setOpen(true)}>Info</button>
                </View>
                <Popover open={open} phonePresentation="sheet" sheetBackdrop="none"
                    accessibilityLabel="Info" anchorRef={anchorRef} focusReturnRef={anchorRef}
                    onRequestClose={() => setOpen(false)}>
                    {() => <Text>Language intelligence answer</Text>}
                </Popover>
            </>;
        }
        try {
            await act(async () => root.render(<Harness />));
            const opener = container.querySelector<HTMLButtonElement>('[data-testid="intelligence-opener"]')!;
            for (const activation of ['pointer', 'keyboard'] as const) {
                await act(async () => { opener.focus(); opener.click(); });
                const dialog = document.querySelector('[role="dialog"]')!;
                expect(dialog).not.toBeNull();
                // PRIMITIVES-A11Y-1111 A19 / e42429c0b29: the grabber is decorative;
                // the header owns the sheet's one named Close control.
                expect(dialog.querySelectorAll('[role="button"][aria-label="Close"]')).toHaveLength(1);
                const close = dialog.querySelector<HTMLElement>('[data-testid="popover-sheet.close"]')!;
                expect(close).not.toBeNull();
                await act(async () => {
                    if (activation === 'pointer') {
                        close.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
                        close.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
                        close.click();
                    } else {
                        close.focus();
                        const down = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
                        close.dispatchEvent(down);
                        close.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
                        // jsdom omits a native button's browser-generated keyboard click.
                        if (close.tagName === 'BUTTON' && !down.defaultPrevented) {
                            close.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
                        }
                    }
                });
                await vi.waitFor(async () => {
                    await act(async () => {});
                    expect(document.querySelector('[role="dialog"]')).toBeNull();
                    expect(document.activeElement).toBe(opener);
                });
            }
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it('preserves pointer focus on a real RNW opener through drag admission, open and Escape', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        function Harness() {
            const [open, setOpen] = React.useState(false);
            const anchorRef = React.useRef<import('react-native').View>(null);
            const drag = useCompanionPointerDragSession({
                coordinateSpace: 'client', selectors: { handle: '[data-glance-handle]', noDrag: '[data-no-drag]' },
                onDragMove: () => {},
            });
            return <>
                <View ref={(node) => { anchorRef.current = node; drag.dragTargetRef(node); }}
                    {...{ dataSet: { glanceHandle: 'true' } }} {...drag.pointerHandlers}>
                    <Pressable testID="pointer-glance-opener" accessibilityRole="button"
                        onPress={() => { if (!drag.shouldSuppressPress()) setOpen(true); }}>
                        <Text>Voice options</Text>
                    </Pressable>
                </View>
                <Popover open={open} phonePresentation="sheet" accessibilityLabel="Voice"
                    anchorRef={anchorRef} focusReturnRef={anchorRef} onRequestClose={() => setOpen(false)}>
                    {() => <Pressable accessibilityRole="button"><Text>Glance</Text></Pressable>}
                </Popover>
            </>;
        }
        try {
            await act(async () => root.render(<Harness />));
            const opener = container.querySelector<HTMLElement>('[data-testid="pointer-glance-opener"]')!;
            const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 20 });
            await act(async () => {
                opener.dispatchEvent(down);
                // jsdom has no browser pointer-focus default action; apply that OS boundary only
                // when the real drag owner leaves the press uncancelled.
                if (!down.defaultPrevented) opener.focus();
                opener.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 10, clientY: 20 }));
                opener.click();
            });
            expect(down.defaultPrevented).toBe(false);
            const dialog = document.querySelector('[role="dialog"]')!;
            expect(dialog).not.toBeNull();
            expect(dialog.contains(document.activeElement)).toBe(true);
            await act(async () => {
                document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            });
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(document.activeElement).toBe(opener);
            });
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it.each(['voice-island-body', 'voice-orb-body'])('returns to %s inside a non-focusable anchor after close and reopen', async (testId) => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        function Harness() {
            const [open, setOpen] = React.useState(false);
            const anchorRef = React.useRef<import('react-native').View>(null);
            const opener = <button data-testid={testId} onClick={() => setOpen(true)}>Voice options</button>;
            return <>
                {testId === 'voice-island-body'
                    // VoiceIsland owns this non-focusable outer View around its shared anatomy.
                    ? <View ref={anchorRef} collapsable={false}>
                        <VoiceIslandAnatomy width={330} height={58} mark={null} body={opener} transport={null} />
                    </View>
                    : <VoiceOrbAnatomy anchorRef={anchorRef}>{opener}</VoiceOrbAnatomy>}
                <Popover open={open} phonePresentation="sheet" accessibilityLabel="Voice"
                    anchorRef={anchorRef} focusReturnRef={anchorRef} onRequestClose={() => setOpen(false)}>
                    {({ requestClose }) => <button data-testid="close-voice-sheet" onClick={() => requestClose('dismiss')}>Collapse</button>}
                </Popover>
            </>;
        }
        try {
            await act(async () => root.render(<Harness />));
            const opener = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
            for (const close of ['collapse', 'escape', 'sheet-close'] as const) {
                await act(async () => { opener.focus(); opener.click(); });
                const dialog = document.querySelector('[role="dialog"]')!;
                expect(dialog).not.toBeNull();
                expect(dialog.contains(document.activeElement)).toBe(true);
                await act(async () => {
                    if (close === 'collapse') document.querySelector<HTMLButtonElement>('[data-testid="close-voice-sheet"]')!.click();
                    else if (close === 'sheet-close') document.querySelector<HTMLButtonElement>('[data-testid="popover-sheet.close"]')!.click();
                    else document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                });
                await vi.waitFor(async () => {
                    await act(async () => {});
                    expect(document.activeElement).toBe(opener);
                });
            }
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });
});

it('dismisses Session Follow and suppresses the touch click on its separate More focus-return button (J-B21)', async () => {
    viewport.width = 900;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const more = vi.fn();
    function Harness() {
        const [open, setOpen] = React.useState(false);
        const chipAnchor = React.useRef<React.ComponentRef<typeof View>>(null);
        const moreButton = React.useRef<HTMLButtonElement>(null);
        return <>
            <View ref={chipAnchor} collapsable={false}>
                <button type="button" aria-expanded={open} onClick={() => setOpen(true)}>Follow</button>
            </View>
            <button type="button" ref={moreButton} onClick={more}>More</button>
            {open ? <FollowEditorPanel anchorRef={chipAnchor} focusReturnRef={moreButton}
                title="Follow" subtitle="Session updates" onRequestClose={() => setOpen(false)} footer={null}>
                <button type="button" data-testid="follow-option">Everything</button>
            </FollowEditorPanel> : null}
        </>;
    }
    try {
        await act(async () => root.render(<Harness />));
        const [chip, moreButton] = container.querySelectorAll<HTMLButtonElement>('button');
        await act(async () => { chip.focus(); chip.click(); });
        const option = document.querySelector<HTMLButtonElement>('[data-testid="follow-option"]')!;
        expect(option).not.toBeNull();

        await act(async () => { option.focus(); moreButton.focus(); });
        expect(document.activeElement).toBe(moreButton);
        expect(chip.getAttribute('aria-expanded')).toBe('true');

        const completeTap = () => {
            moreButton.dispatchEvent(Object.assign(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
                { pointerType: 'touch' }));
            return moreButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        };
        let clickDelivered = true;
        await act(async () => { clickDelivered = completeTap(); });
        expect({
            open: chip.getAttribute('aria-expanded'),
            clickDelivered,
            moreActivations: more.mock.calls.length,
        }).toEqual({ open: 'false', clickDelivered: false, moreActivations: 0 });
        await act(async () => { completeTap(); });
        expect(more).toHaveBeenCalledOnce();
    } finally {
        await act(async () => root.unmount());
        container.remove();
        viewport.width = 390;
    }
});

it('dismisses a desktop anchored popover only on focus departure, including from a portaled submenu', async () => {
    viewport.width = 1440;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const close = vi.fn();
    function Harness() {
        const [open, setOpen] = React.useState(true);
        const [submenuOpen, setSubmenuOpen] = React.useState(false);
        const trigger = React.useRef<HTMLButtonElement>(null);
        const submenuTrigger = React.useRef<HTMLButtonElement>(null);
        return <>
            <button ref={trigger} data-testid="anchor">Actions</button>
            <button data-testid="outside">Outside</button>
            <Popover open={open} anchor={{ kind: 'view', ref: trigger }} portal={{ web: true }}
                onRequestClose={() => { close(); setOpen(false); }}>
                {() => <button ref={submenuTrigger} data-testid="submenu-anchor" onClick={() => setSubmenuOpen(true)}>More</button>}
            </Popover>
            <Popover open={submenuOpen} anchor={{ kind: 'view', ref: submenuTrigger }} portal={{ web: true }}
                autoFocusOnOpen onRequestClose={() => setSubmenuOpen(false)}>
                {() => <button data-testid="submenu-item">Child action</button>}
            </Popover>
        </>;
    }
    const get = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
    try {
        await act(async () => root.render(<Harness />));
        await act(async () => { get('submenu-anchor').focus(); get('anchor').focus(); });
        expect(close).not.toHaveBeenCalled();
        await act(async () => { get('submenu-anchor').focus(); get('submenu-anchor').click(); });
        expect(document.activeElement).toBe(get('submenu-item'));
        expect(close).not.toHaveBeenCalled();
        await act(async () => get('outside').focus());
        expect(close).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(get('outside'));
    } finally {
        await act(async () => root.unmount());
        container.remove();
        viewport.width = 390;
    }
});

it('keeps a desktop anchored popover open as focus moves into its declared in-page boundary', async () => {
    viewport.width = 1440;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const close = vi.fn();
    function Harness() {
        const trigger = React.useRef<HTMLButtonElement>(null);
        const boundary = React.useRef<HTMLDivElement>(null);
        return <>
            <div ref={boundary}>
                <button ref={trigger}>Customize</button>
                <button data-testid="page-boundary">Related control</button>
            </div>
            <Popover open anchor={{ kind: 'view', ref: trigger }} portal={{ web: true }}
                interactionBoundaryRef={boundary} onRequestClose={close}>
                {() => <button data-testid="menu-item">Change section</button>}
            </Popover>
        </>;
    }
    const get = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
    try {
        await act(async () => root.render(<Harness />));
        await act(async () => { get('menu-item').focus(); get('page-boundary').focus(); });
        expect(document.activeElement).toBe(get('page-boundary'));
        expect(close).not.toHaveBeenCalled();
    } finally {
        await act(async () => root.unmount());
        container.remove();
        viewport.width = 390;
    }
});

it.each(['inside label', 'window blur and return'] as const)('keeps an anchored popover open after %s', async cause => {
    viewport.width = 1440;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Harness() {
        const [open, setOpen] = React.useState(true);
        const trigger = React.useRef<HTMLButtonElement>(null);
        return <>
            <button ref={trigger} aria-expanded={open}>Actions</button>
            <Popover open={open} anchor={{ kind: 'view', ref: trigger }} portal={{ web: true }}
                onRequestClose={() => setOpen(false)}>
                {() => <>
                    <TextInput accessibilityLabel="Search actions" />
                    <span data-testid="action-group-label">More actions</span>
                </>}
            </Popover>
        </>;
    }
    try {
        await act(async () => root.render(<Harness />));
        const search = document.querySelector<HTMLInputElement>('[aria-label="Search actions"]')!;
        const label = document.querySelector<HTMLElement>('[data-testid="action-group-label"]')!;
        const trigger = container.querySelector('button')!;
        const blurTarget = vi.fn();
        search.addEventListener('focusout', event => blurTarget(event.relatedTarget), { once: true });
        search.focus();
        expect(document.activeElement).toBe(search);
        await act(async () => {
            if (cause === 'inside label') {
                label.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
                // JSDOM leaves the default pointer focus transition to the caller.
                search.blur();
                label.click();
            } else {
                search.blur();
                window.dispatchEvent(new FocusEvent('blur'));
            }
        });
        expect(document.activeElement).toBe(document.body);
        expect(blurTarget).toHaveBeenCalledWith(null);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(label.isConnected).toBe(true);
        await act(async () => {
            if (cause === 'window blur and return') window.dispatchEvent(new FocusEvent('focus'));
            search.focus();
        });
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        await act(async () => {
            search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(trigger);
    } finally {
        await act(async () => root.unmount());
        container.remove();
        viewport.width = 390;
    }
});
