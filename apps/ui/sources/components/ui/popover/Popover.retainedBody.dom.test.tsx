/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

const viewport = vi.hoisted(() => ({ width: 1440, height: 1000 }));
const dimensionSubscriptions = vi.hoisted(() => new Set<() => void>());
installPopoverCommonModuleMocks({
    reactNative: async () => ({
        ...await vi.importActual<typeof import('react-native-web')>('react-native-web'),
        // Physical dimensions are the boundary; placement, portals, sheet and motion stay real.
        useWindowDimensions: () => ({ ...viewport, scale: 1, fontScale: 1 }),
        Dimensions: {
            get: () => ({ ...viewport, scale: 1, fontScale: 1 }),
            addEventListener: (_event: string, listener: () => void) => {
                dimensionSubscriptions.add(listener);
                return { remove: () => { dimensionSubscriptions.delete(listener); } };
            },
        },
    }),
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { Popover } = await import('./Popover');
const { FloatingOverlaySheetContext } = await import('@/components/ui/overlays/FloatingOverlay');
const { View } = await import('react-native');
const { setReducedMotionPreferenceOverride } = await import('@/hooks/ui/useReducedMotionPreference');

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); setReducedMotionPreferenceOverride(null); viewport.width = 1440; viewport.height = 1000; });

describe('Popover content across its anchored and sheet presentations', () => {
    it.each([false, true])('acquires one presentation only on demand and releases it after exit (reduced motion: %s)', async (reducedMotion) => {
        vi.useFakeTimers();
        setReducedMotionPreferenceOverride(reducedMotion);
        const container = document.createElement('div');
        const anchor = document.createElement('button');
        document.body.append(container, anchor);
        const root = createRoot(container);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 160, 40));
        // DOM allocation/listeners and platform subscriptions are real resource boundaries.
        const createElement = vi.spyOn(document, 'createElement');
        const listen = vi.spyOn(HTMLElement.prototype, 'addEventListener');
        const unlisten = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
        const render = async (count: number, open: boolean) => {
            await act(async () => { root.render(<>{Array.from({ length: count }, (_, index) =>
                <Popover key={index} open={open && index === 0} anchorRef={{ current: anchor }}
                    portal={{ web: true, matchAnchorWidth: false }} onRequestClose={() => {}}>
                    {() => <div data-testid="demand-body" />}
                </Popover>)}</>); });
        };
        const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(400); }); };
        try {
            await render(168, false);
            expect(createElement.mock.calls.filter(([tag]) => tag === 'div')).toHaveLength(0);
            expect(listen.mock.calls.filter(([event]) => event === 'focusout')).toHaveLength(0);
            expect(dimensionSubscriptions.size).toBe(0);
            await render(168, true);
            await settle();
            expect(document.querySelectorAll('[data-testid="demand-body"]')).toHaveLength(1);
            const onePresentationSubscriptions = dimensionSubscriptions.size;
            expect(onePresentationSubscriptions).toBeGreaterThan(0);
            const beforeClose = unlisten.mock.calls.length;
            await render(168, false);
            if (!reducedMotion) {
                // Closing is not absence: the existing exit still owns the body and its resources.
                expect(document.querySelectorAll('[data-testid="demand-body"]')).toHaveLength(1);
                expect(dimensionSubscriptions.size).toBe(onePresentationSubscriptions);
                expect(unlisten.mock.calls.slice(beforeClose).filter(([event]) => event === 'focusout')).toHaveLength(0);
                await act(async () => { await vi.advanceTimersByTimeAsync(motionTokens.overlay.popover.exitMs - 1); });
                expect(document.querySelectorAll('[data-testid="demand-body"]')).toHaveLength(1);
                await act(async () => { await vi.advanceTimersByTimeAsync(1); });
            }
            await settle();
            expect(document.querySelector('[data-testid="demand-body"]')).toBeNull();
            expect(dimensionSubscriptions.size).toBe(0);
            // React's delegated portal listeners live with their collectible node. The retained host's
            // own focus listener is explicitly released once, at the same exit boundary.
            const releasedFocus = unlisten.mock.calls.slice(beforeClose).flatMap(([event, listener], index) =>
                event === 'focusout' ? [{ listener, host: unlisten.mock.contexts[beforeClose + index] }] : []);
            expect(releasedFocus).toHaveLength(1);
            expect(releasedFocus[0]!.host.isConnected).toBe(false);
            expect(listen.mock.calls.some(([event, listener], index) => event === 'focusout'
                && listener === releasedFocus[0]!.listener && listen.mock.contexts[index] === releasedFocus[0]!.host)).toBe(true);
            await render(1, true);
            await settle();
            // N closed siblings add nothing to an isolated open popover's dependency graph.
            expect(dimensionSubscriptions.size).toBe(onePresentationSubscriptions);
            expect(document.querySelectorAll('[data-testid="demand-body"]')).toHaveLength(1);
        } finally {
            await act(async () => root.unmount());
            container.remove(); anchor.remove();
        }
        expect(dimensionSubscriptions.size).toBe(0);
    });

    it('retains a pushed web body through its phone step exit, then releases its presentation', async () => {
        vi.useFakeTimers();
        setReducedMotionPreferenceOverride(false);
        viewport.width = 390; viewport.height = 844;
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        let setPicker: (open: boolean) => void = () => {};
        function Harness() {
            const [picker, selectPicker] = React.useState(false);
            setPicker = selectPicker;
            return <Popover open phonePresentation="sheet" accessibilityLabel="Menu" onRequestClose={() => {}}>
                {() => <div>Menu
                    <Popover open={picker} phonePresentation="sheet" accessibilityLabel="Picker" onRequestClose={() => selectPicker(false)}>
                        {() => <input data-testid="pushed-form" />}
                    </Popover>
                </div>}
            </Popover>;
        }
        const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(400); }); };
        try {
            await act(async () => { root.render(<Harness />); });
            await settle();
            const parentSubscriptions = dimensionSubscriptions.size;
            await act(async () => { setPicker(true); });
            await settle();
            const input = document.querySelector('[data-testid="pushed-form"]');
            expect(input).not.toBeNull();
            const withPickerSubscriptions = dimensionSubscriptions.size;
            expect(withPickerSubscriptions).toBeGreaterThan(parentSubscriptions);
            await act(async () => { setPicker(false); });
            expect(document.querySelector('[data-testid="pushed-form"]')).toBe(input);
            expect(dimensionSubscriptions.size).toBe(withPickerSubscriptions);
            await settle();
            expect(document.querySelector('[data-testid="pushed-form"]')).toBeNull();
            expect(dimensionSubscriptions.size).toBe(parentSubscriptions);
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
        expect(dimensionSubscriptions.size).toBe(0);
    });

    it('keeps one mounted body (typed text, local state) when the window crosses the phone breakpoint, and retires it on close', async () => {
        vi.useFakeTimers();
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            return this.dataset.testid === 'retained-trigger' ? new DOMRect(100, 200, 160, 40) : new DOMRect(0, 0, 360, 300);
        });
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        let mounts = 0;
        function Form(props: Readonly<{ presentation: string }>) {
            React.useEffect(() => { mounts += 1; }, []);
            const [step, setStep] = React.useState('choose');
            const onSheet = React.useContext(FloatingOverlaySheetContext);
            return <div data-testid="retained-form" data-step={step} data-presentation={props.presentation} data-on-sheet={String(onSheet)}>
                <input data-testid="retained-input" defaultValue="" />
                <button data-testid="retained-next" onClick={() => setStep('source')}>Next</button>
            </div>;
        }
        let setOpenOutside: (open: boolean) => void = () => {};
        function Harness() {
            const [open, setOpen] = React.useState(false);
            setOpenOutside = setOpen;
            const anchor = React.useRef<React.ComponentRef<typeof View>>(null);
            return <>
                <View ref={anchor} testID="retained-trigger"><button onClick={() => setOpen(true)}>Options</button></View>
                <Popover open={open} anchorRef={anchor} phonePresentation="sheet" accessibilityLabel="Options"
                    placement="bottom" maxHeightCap={400} maxWidthCap={360}
                    portal={{ web: true, matchAnchorWidth: false }} onRequestClose={() => setOpen(false)}>
                    {({ presentation }) => <Form presentation={presentation ?? 'popover'} />}
                </Popover>
            </>;
        }
        const form = () => document.querySelector<HTMLElement>('[data-testid="retained-form"]');
        const input = () => document.querySelector<HTMLInputElement>('[data-testid="retained-input"]');
        const settled = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(400); }); };
        const resize = async (width: number, height: number) => {
            viewport.width = width; viewport.height = height;
            await act(async () => { root.render(<Harness />); });
            await settled();
        };
        try {
            await act(async () => { root.render(<Harness />); });
            await act(async () => { container.querySelector('button')!.click(); });
            await settled();
            const typed = input()!;
            typed.value = 'env-42';
            await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="retained-next"]')!.click(); });
            expect(form()!.dataset.onSheet).toBe('false');

            await resize(390, 844);
            expect(document.querySelector('[role="dialog"]')).not.toBeNull();
            expect(input()).toBe(typed);
            expect(input()!.value).toBe('env-42');
            expect(form()!.dataset.step).toBe('source');
            // The body reads the shell it is presented in now.
            expect(form()!.dataset.presentation).toBe('sheet');
            expect(form()!.dataset.onSheet).toBe('true');

            await resize(1440, 1000);
            expect(input()).toBe(typed);
            expect(input()!.value).toBe('env-42');
            expect(form()!.dataset.step).toBe('source');
            expect(form()!.dataset.onSheet).toBe('false');
            expect(mounts).toBe(1);

            // A genuine close retires the body: reopening starts fresh.
            await act(async () => { setOpenOutside(false); });
            await settled();
            expect(form()).toBeNull();
            await act(async () => { setOpenOutside(true); });
            await settled();
            expect(form()!.dataset.step).toBe('choose');
            expect(input()!.value).toBe('');
            expect(mounts).toBe(2);
            const reopened = input();
            await act(async () => { setOpenOutside(false); });
            await act(async () => { setOpenOutside(true); });
            await settled();
            expect(input()).toBe(reopened);
            expect(mounts).toBe(2);

            // A new, already-absent shell must not strand the outgoing presentation's resources.
            viewport.width = 390; viewport.height = 844;
            await act(async () => { setOpenOutside(false); root.render(<Harness />); });
            await settled();
            expect(form()).toBeNull();
            expect(dimensionSubscriptions.size).toBe(0);
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });
});
