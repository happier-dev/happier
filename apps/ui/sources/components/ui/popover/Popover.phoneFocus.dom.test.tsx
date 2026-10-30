/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const nativeWeb = await vi.importActual<typeof import('react-native-web')>('react-native-web');
        return {
            ...nativeWeb,
            // Viewport dimensions are a platform boundary; real RNW refs, sheet and focus owners run below it.
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
        };
    },
});

const { Popover } = await import('./Popover');
const { View, Pressable, Text } = await import('react-native');
const { VoiceIslandAnatomy, VoiceOrbAnatomy } = await import('@/components/voice/presence/voicePresenceAnatomy');
const { useCompanionPointerDragSession } = await import('@/components/companion/interaction/useCompanionPointerDragSession');

describe('Popover phone-sheet focus return', () => {
    it('dismisses a headerless intelligence sheet through the shared Close grabber and restores the opener', async () => {
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
                <Popover open={open} phonePresentation="sheet" sheetHeader="none" sheetBackdrop="none"
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
                const close = dialog.querySelector<HTMLElement>('[role="button"][aria-label="Close"]')!;
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
