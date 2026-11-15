/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

const viewport = vi.hoisted(() => ({ width: 1440, height: 1000 }));
installPopoverCommonModuleMocks({
    reactNative: async () => ({
        ...await vi.importActual<typeof import('react-native-web')>('react-native-web'),
        // Physical dimensions are the boundary; the trigger shell, popovers, sheet and push stack stay real.
        useWindowDimensions: () => ({ ...viewport, scale: 1, fontScale: 1 }),
        Dimensions: {
            get: () => ({ ...viewport, scale: 1, fontScale: 1 }),
            addEventListener: () => ({ remove: () => {} }),
        },
    }),
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { TriggerAnchoredPopoverShell, TRIGGER_POPOVER_WIDTH } = await import('./TriggerPopover');
const { Popover } = await import('@/components/ui/popover/Popover');
const { View, TextInput } = await import('react-native');

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); viewport.width = 1440; viewport.height = 1000; });

// E09 (QA-EDITOR-1114): the trigger popover's "At" text and a source form opened inside it (its Environment Id) survive
// 1440 → 390 → 1440, where the trigger shell turns into a phone sheet and the inner popover pushes into it.
it('keeps the trigger popover form and a source form opened inside it across the phone breakpoint (E09)', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid?.endsWith('-anchor') ? new DOMRect(100, 200, 160, 40) : new DOMRect(0, 0, 360, 300);
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function SourceForm() {
        const anchor = React.useRef<React.ComponentRef<typeof View>>(null);
        const [open, setOpen] = React.useState(false);
        return <View>
            <TextInput testID="e09-at" defaultValue="" />
            <View ref={anchor} testID="e09-source-anchor"><button data-testid="e09-configure-source" onClick={() => setOpen(true)}>Configure source</button></View>
            <Popover open={open} anchorRef={anchor} phonePresentation="sheet" accessibilityLabel="Configure source"
                portal={{ web: true }} onRequestClose={() => setOpen(false)}>
                {() => <TextInput testID="e09-environment-id" defaultValue="" />}
            </Popover>
        </View>;
    }
    function Harness() {
        const anchor = React.useRef<View | null>(null);
        return <>
            <View ref={anchor} testID="e09-trigger-anchor" />
            <TriggerAnchoredPopoverShell open autoFocusOnOpen phonePresentation="sheet" anchorRef={anchor}
                accessibilityLabel="New trigger" maxWidthCap={TRIGGER_POPOVER_WIDTH} maxHeightCap={640} onRequestClose={() => {}}>
                {() => <SourceForm />}
            </TriggerAnchoredPopoverShell>
        </>;
    }
    const field = (id: string) => document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
    const settled = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(400); }); };
    const resize = async (width: number, height: number) => {
        viewport.width = width; viewport.height = height;
        await act(async () => { root.render(<Harness />); });
        await settled();
    };
    try {
        await act(async () => { root.render(<Harness />); });
        await settled();
        const at = field('e09-at')!;
        at.value = '09:30';
        await act(async () => { field('e09-configure-source')!.click(); });
        await settled();
        const environmentId = field('e09-environment-id')!;
        environmentId.value = 'env-prod-7';

        await resize(390, 844);
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        expect(field('e09-at')).toBe(at);
        expect(field('e09-environment-id')).toBe(environmentId);

        await resize(1440, 1000);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(field('e09-at')).toBe(at);
        expect(at.value).toBe('09:30');
        expect(field('e09-environment-id')).toBe(environmentId);
        expect(environmentId.value).toBe('env-prod-7');
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});
