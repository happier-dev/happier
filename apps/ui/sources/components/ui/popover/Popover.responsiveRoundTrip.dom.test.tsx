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
const { View } = await import('react-native');

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); viewport.width = 1440; viewport.height = 1000; });

describe('Popover responsive placement lifecycle', () => {
    it('remeasures its anchor and content after a desktop → sheet → desktop round trip before exposing the panel', async () => {
        vi.useFakeTimers();
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        let anchorX = 100;
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            return this.dataset.testid === 'responsive-trigger'
                ? new DOMRect(anchorX, 200, 160, 40)
                : new DOMRect(0, 0, 360, 300);
        });
        function Harness() {
            const [open, setOpen] = React.useState(false);
            const anchor = React.useRef<React.ComponentRef<typeof View>>(null);
            return <>
                <View ref={anchor} testID="responsive-trigger"><button onClick={() => setOpen(true)}>Options</button></View>
                <Popover open={open} anchorRef={anchor} phonePresentation="sheet" accessibilityLabel="Options"
                    placement="bottom" maxHeightCap={400} maxWidthCap={360}
                    portal={{ web: true, matchAnchorWidth: false }} onRequestClose={() => setOpen(false)}>
                    {() => <button data-testid="responsive-done" onClick={() => setOpen(false)}>Done</button>}
                </Popover>
            </>;
        }
        const portal = () => document.querySelector<HTMLElement>('[id^="popover-"]')!;
        const settled = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(200); }); };
        const checkPlacement = () => {
            const panel = portal();
            expect(panel.style.opacity).toBe('1');
            expect(Number.parseFloat(panel.style.left)).toBe(anchorX);
            const top = Number.parseFloat(panel.style.top);
            expect(top).toBe(248);
            expect(top).toBeGreaterThanOrEqual(0);
            expect(top + 300).toBeLessThanOrEqual(viewport.height);
        };
        try {
            await act(async () => { root.render(<Harness />); });
            await act(async () => { container.querySelector('button')!.click(); });
            await settled();
            checkPlacement();
            viewport.width = 390; viewport.height = 844;
            await act(async () => { root.render(<Harness />); });
            await settled();
            expect(document.querySelector('[role="dialog"]')).not.toBeNull();
            expect(portal()).toBeNull();
            // Responsive reflow moved the same opener. The synchronous layout publication
            // must expose its new coordinates without waiting for another frame.
            anchorX = 1000;
            viewport.width = 1440; viewport.height = 1000;
            await act(async () => { root.render(<Harness />); });
            checkPlacement();
            await settled();
            checkPlacement();
            await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="responsive-done"]')!.click(); });
            await settled();
            expect(portal()).toBeNull();
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });
});
