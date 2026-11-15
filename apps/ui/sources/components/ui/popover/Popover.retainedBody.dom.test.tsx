/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

const viewport = vi.hoisted(() => ({ width: 1440, height: 1000 }));
installPopoverCommonModuleMocks({
    reactNative: async () => ({
        ...await vi.importActual<typeof import('react-native-web')>('react-native-web'),
        // Physical dimensions are the boundary; placement, portals, sheet and motion stay real.
        useWindowDimensions: () => ({ ...viewport, scale: 1, fontScale: 1 }),
        Dimensions: {
            get: () => ({ ...viewport, scale: 1, fontScale: 1 }),
            addEventListener: () => ({ remove: () => {} }),
        },
    }),
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { Popover } = await import('./Popover');
const { FloatingOverlaySheetContext } = await import('@/components/ui/overlays/FloatingOverlay');
const { View } = await import('react-native');

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); viewport.width = 1440; viewport.height = 1000; });

describe('Popover content across its anchored and sheet presentations', () => {
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
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });
});
