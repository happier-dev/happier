import { describe, expect, it, vi } from 'vitest';

/**
 * The picker's geometry module must be IMPORTABLE without a Reanimated runtime.
 *
 * Every function in it is a `'worklet'`, and this module is reached from
 * `MobileBottomChromeHost`, which is mounted on every route — so a module-scope call into
 * anything animation-shaped takes the whole chrome down. On device it surfaced as
 * `Cannot read property 'SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES' of undefined`,
 * because a module that throws while evaluating leaves its namespace undefined for every
 * importer. Same contract, and same shape of test, as
 * `components/ui/motion/motionSprings.importIsolation.test.ts` and
 * `SessionCockpitChromeRegistry.importIsolation.test.tsx`.
 *
 * The empty mock below is the condition under test, not a shortcut around the testkit.
 */
vi.mock('react-native-reanimated', () => ({}));

describe('sessionLateralPickerState import isolation', () => {
    it('imports with no Reanimated runtime at all, because nothing is invoked at module scope', async () => {
        const state = await import('./sessionLateralPickerState');

        expect(state.SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES).toBeTypeOf('number');
        expect(state.SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES)
            .toBe(state.SESSION_LATERAL_PICKER_REACH_ROWS + 1);
        expect(state.resolveSessionLateralPickerRowMotion).toBeTypeOf('function');
    });
});
