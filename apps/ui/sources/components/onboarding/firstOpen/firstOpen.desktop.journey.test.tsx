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
import { createDesktopHostInternals } from '@/dev/testkit/harness/desktopHttpHost';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

import { installFirstOpenWebGraphics } from './firstOpenWebGraphics.fixture';

// Preload Vitest's source transforms so the journey measures presenter readiness.
import './FirstOpenOverlayPresentation';

vi.mock('react-native', async () => await vi.importActual('react-native-web'));
// Vitest uses the source fallback without Metro's web-extension precedence.
vi.mock('@/components/atmosphere/glyph/GlyphSurface', async () =>
    await vi.importActual('@/components/atmosphere/glyph/GlyphSurface.web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
it('waits for a painted presenter, builds the inert live Welcome model, and swaps once on Escape', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    const events = new Map<string, number>();
    const host = createDesktopHostInternals(({ command, args }) => {
        if (command === 'plugin:event|listen' && typeof args.event === 'string' && typeof args.handler === 'number') {
            events.set(args.event, args.handler);
            return args.handler;
        }
        if (command === 'plugin:event|unlisten' && typeof args.event === 'string') events.delete(args.event);
        return null;
    });
    const label = 'first_open_overlay';
    vi.stubGlobal('__TAURI_INTERNALS__', { ...host.internals, metadata: { currentWindow: { label } } });
    vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
    const openingCalls = () => host.calls.map(call => call.command).filter(command => command.startsWith('desktop_first_open_'));
    const emit = (event: string, payload: unknown) => {
        const id = events.get(event);
        if (id === undefined) throw new Error(`No presenter listener for ${event}`);
        host.deliver(id, { event, id, payload });
    };
    setReducedMotionPreferenceOverride(false);
    const box = document.createElement('div');
    document.body.append(box);
    const root = createRoot(box);
    const frame = { x: 0, y: 0, width: 1440, height: 900 };
    const draw = vi.fn();
    const restoreGraphics = installFirstOpenWebGraphics(frame.width, frame.height, draw);
    const placement = { overlayFrame: frame, windowRect: { x: 250, y: 80, width: 940, height: 740 }, cursor: null };
    const welcome = {
        heading: { title: 'Set up Happier', subtitle: 'Welcome' },
        doors: [{ index: 0, display: { title: 'Start', testID: 'welcome-primary-start', primary: true } }],
        quietWays: [], notices: [],
        selfHosting: { display: { testID: 'welcome-self-hosting', title: 'Run your own Home' } },
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
        await vi.waitFor(() => expect(events.has('first_open:prepare')).toBe(true));
        expect(openingCalls()).toEqual([]);
        await act(async () => { emit('first_open:prepare', placement); });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(openingCalls()).toEqual(['desktop_first_open_overlay_ready']);
            expect(box.querySelectorAll('canvas[data-glyph-linked=true][data-glyph-first-draw-ms]').length).toBe(1);
        }, { timeout: 10_000 });
        expect(box.textContent).not.toContain('Set up Happier');
        await act(async () => emit('first_open:start', {
            ...placement, epoch: performance.timeOrigin + performance.now(), welcome,
        }));
        expect(box.textContent).toContain('Set up Happier');
        const door = box.querySelector('[data-testid="welcome-primary-start"]');
        expect(door?.closest('[inert]')?.getAttribute('aria-hidden')).toBe('true');
        expect(door?.getAttribute('aria-disabled')).toBe('true');
        const cornerDoor = box.querySelector('[data-testid="unauth-shell-corner"] [data-testid="welcome-self-hosting"]');
        expect(cornerDoor?.getAttribute('aria-disabled')).toBe('true');
        await act(async () => emit('first_open:welcome', {
            ...welcome, heading: { title: 'Welcome back', subtitle: 'Happier' },
        }));
        expect(box.textContent).toContain('Welcome back');
        const scene = box.querySelector('[data-testid="first-open.scene"]');
        expect(scene).toBeTruthy();

        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
        });
        expect(openingCalls().filter(command => command === 'desktop_first_open_swap')).toHaveLength(1);
        expect([...box.querySelectorAll('canvas')]).toEqual([...scene!.querySelectorAll('canvas')]);
        const drawsAtSwap = draw.mock.calls.length;
        await act(async () => {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        });
        expect(draw).toHaveBeenCalledTimes(drawsAtSwap);
    } finally {
        await act(async () => root.unmount());
        expect([...events.keys()].filter(event => event.startsWith('first_open:'))).toEqual([]);
        bounds.mockRestore();
        box.remove();
        setReducedMotionPreferenceOverride(null);
        restoreGraphics();
        vi.unstubAllGlobals();
    }
}, 15_000);
