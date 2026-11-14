import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { PairingQrMomentCanvas as WebCanvas } from './PairingQrMoment.web';
import { PairingQrMomentCanvas as NativeCanvas } from './PairingQrMoment.native';
import type { PairingQrMomentCanvasProps } from './pairingQrMoment.types';
import type { QrMomentScene } from './pairingQrMomentTimeline';

const host = vi.hoisted(() => ({ emitter: null as ReturnType<typeof import('@/dev/testkit/mocks/reactNative').createReactNativeAppStateEmitter> | null }));
vi.mock('react-native', async () => {
    const kit = await import('@/dev/testkit/mocks/reactNative');
    host.emitter = kit.createReactNativeAppStateEmitter();
    return kit.createReactNativeWebMock({ AppState: host.emitter.appState });
});
// Font and picture handles are native system boundaries; the real scene/timeline stays intact.
vi.mock('@shopify/react-native-skia', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock(),
    useTypeface: () => ({}),
}));

beforeEach(() => vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] }));
afterEach(async () => {
    await act(async () => { host.emitter?.emit('active'); });
    vi.useRealTimers();
});

describe.each([['web', WebCanvas], ['native', NativeCanvas]] as const)('%s pairing moment lifetime', (_platform, Canvas) => {
    it('does not schedule display frames in a retained inactive pane', async () => {
        const element = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active}>
            <Canvas size={240} theme="light" reducedMotion={false} pairing machines={[]}
                scene={{ kind: 'assemble', link: 'happier://pair/example', atMs: 0 }} />
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(element(false), {
            createNodeMock: node => node.type === 'canvas' ? { getContext: () => null } : null,
        });
        expect(vi.getTimerCount()).toBe(0);
        await screen.update(element(true));
        expect(vi.getTimerCount()).toBe(1);
        await screen.update(element(false));
        expect(vi.getTimerCount()).toBe(0);
        await screen.unmount();
    });
    it('cancels display frames while hidden, then renders the current lifecycle and settles', async () => {
        const props = { size: 240, theme: 'light', reducedMotion: false, pairing: true, machines: [],
            scene: { kind: 'assemble', link: 'happier://pair/example', atMs: 0 },
        } satisfies PairingQrMomentCanvasProps & { scene: QrMomentScene };
        const screen = await renderScreen(<Canvas {...props} />, {
            createNodeMock: node => node.type === 'canvas' ? { getContext: () => null } : null,
        });
        expect(vi.getTimerCount()).toBe(1);
        await act(async () => { vi.advanceTimersByTime(96); host.emitter!.emit('background'); });
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { vi.advanceTimersByTime(60_000); });
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { host.emitter!.emit('active'); });
        // Pairing's timeline follows actual code/scan times, so a resumed old code is already held.
        expect(vi.getTimerCount()).toBe(0);
        await screen.update(<Canvas {...props} scene={{ kind: 'assemble', link: 'happier://pair/next', atMs: performance.now() }} />);
        expect(vi.getTimerCount()).toBe(1);
        await screen.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});
