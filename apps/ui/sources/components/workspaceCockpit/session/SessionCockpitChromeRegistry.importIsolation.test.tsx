import { describe, expect, it, vi } from 'vitest';

/**
 * The cockpit chrome registry must be IMPORTABLE without a Reanimated runtime.
 *
 * This registry is mounted app-wide from `app/(app)/_layout.tsx`, so it is pulled into the
 * module graph of practically every screen suite — including suites that have nothing to do
 * with the bottom chrome. When the lateral-swipe idle state was constructed at module scope
 * (`makeMutable(0)` in a top-level constant, and again as a `createContext` default), merely
 * importing this file reached into the animation runtime, and every suite that overrides the
 * canonical testkit mock with a hand-rolled subset failed at collection with an error about
 * `makeMutable` rather than about anything it was testing.
 *
 * `motionSprings.importIsolation.test.ts` records the identical lesson from the identical
 * cause: `dev/vitestSetup.ts` installs `createReanimatedModuleMock()` for every suite, but
 * many suites still hand-roll a subset. Requiring all of them to restate a new export is not
 * a contract; not needing the runtime until a shared value is actually read is.
 *
 * This file hand-rolls a mock WITHOUT `makeMutable` on purpose — that partial mock is the
 * condition under test, not a shortcut around the testkit.
 */
vi.mock('react-native-reanimated', () => ({
    // Deliberately incomplete: no `makeMutable`. `useSharedValue` exists because the provider
    // legitimately calls it during render, which is a different (and permitted) moment.
    useSharedValue: <T,>(initial: T) => ({ value: initial }),
}));

describe('session cockpit chrome registry import isolation', () => {
    it('imports without constructing a shared value, so a partial Reanimated mock cannot fail collection', async () => {
        const registry = await import('./SessionCockpitChromeRegistry');

        expect(registry.SessionCockpitChromeRegistryProvider).toBeTypeOf('function');
        expect(registry.useSessionLateralSwipe).toBeTypeOf('function');
    });

    it('still exposes the bottom-chrome height context that non-animating consumers reach for', async () => {
        // `SessionCockpitFullscreenSurface` and `AgentContentView` read this to reserve the band.
        // Neither animates, and neither should be forced to carry a Reanimated mock.
        const registry = await import('./SessionCockpitChromeRegistry');

        expect(registry.SessionCockpitBottomChromeHeightContext).toBeDefined();
    });
});
