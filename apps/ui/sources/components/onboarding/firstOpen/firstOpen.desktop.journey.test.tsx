/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { expect, it, vi } from 'vitest';

import opening from '@/app/(app)/desktop/opening';
import type { WelcomeEntryViewModel } from '@/components/onboarding/preAuth/WelcomeEntryView';
import { StepMotionStage } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

const host = vi.hoisted(() => ({
    invoke: vi.fn(async (_command: string) => undefined),
    events: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('react-native', async () => await vi.importActual('react-native-web'));
// Vitest uses the source fallback without Metro's web-extension precedence.
vi.mock('@/components/atmosphere/glyph/GlyphSurface', async () =>
    await vi.importActual('@/components/atmosphere/glyph/GlyphSurface.web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => {
    const { createDesktopHostModuleMock } = await import('@/dev/testkit/mocks/desktopHost');
    return createDesktopHostModuleMock({
        importOriginal,
        overrides: {
            getDesktopHostWindowLabel: () => 'first_open_overlay',
            invokeDesktopHost: async <T,>(command: string) => await host.invoke(command) as T,
            listenDesktopHostEvent: async <T,>(name: string, callback: (payload: T) => void) => {
                host.events.set(name, payload => callback(payload as T));
                return () => { host.events.delete(name); };
            },
        },
    });
});
vi.mock('@/components/atmosphere/glyph/glyphPainter.web', () => ({
    createWebGlyphPainter: () => ({ ready: true, renderer: 'test GPU', paint() {}, dispose() {} }),
    warmWebGlyphAtlas: async () => ({}),
}));

it('waits for a painted presenter, builds the inert live Welcome model, and swaps once on Escape', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    setReducedMotionPreferenceOverride(false);
    const box = document.createElement('div');
    document.body.append(box);
    const root = createRoot(box);
    const frame = { x: 0, y: 0, width: 1440, height: 900 };
    const placement = { overlayFrame: frame, windowRect: { x: 250, y: 80, width: 940, height: 740 }, cursor: null };
    const welcome = {
        heading: { title: 'Set up Happier', subtitle: 'Welcome' },
        doors: [{ index: 0, display: { title: 'Start', testID: 'welcome-primary-start', primary: true } }],
        quietWays: [], notices: [],
    } satisfies WelcomeEntryViewModel;
    const Route = opening;
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(250, 80, 940, 740),
    );
    try {
        await act(async () => root.render(
            <SafeAreaProvider initialMetrics={{ frame, insets: { top: 0, right: 0, bottom: 0, left: 0 } }}>
                <StepMotionStage><Route /></StepMotionStage>
            </SafeAreaProvider>,
        ));
        expect(host.invoke).not.toHaveBeenCalled();
        await act(async () => host.events.get('first_open:prepare')?.(placement));
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(host.invoke).toHaveBeenCalledWith('desktop_first_open_overlay_ready');
        });
        expect(box.textContent).not.toContain('Set up Happier');
        await act(async () => host.events.get('first_open:start')?.({
            ...placement, epoch: performance.timeOrigin + performance.now(), welcome,
        }));
        expect(box.textContent).toContain('Set up Happier');
        const door = box.querySelector('[data-testid="welcome-primary-start"]');
        expect(door?.closest('[inert]')?.getAttribute('aria-hidden')).toBe('true');
        expect(door?.getAttribute('aria-disabled')).toBe('true');
        await act(async () => host.events.get('first_open:welcome')?.({
            ...welcome, heading: { title: 'Welcome back', subtitle: 'Happier' },
        }));
        expect(box.textContent).toContain('Welcome back');

        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
        });
        expect(host.invoke.mock.calls.filter(([command]) => command === 'desktop_first_open_swap')).toHaveLength(1);
    } finally {
        await act(async () => root.unmount());
        expect(host.events.size).toBe(0);
        bounds.mockRestore();
        box.remove();
        setReducedMotionPreferenceOverride(null);
        vi.unstubAllGlobals();
    }
});
