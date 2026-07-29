import { describe, expect, it } from 'vitest';

import { enterDemoMode, exitDemoMode, isDemoModeActive, resetDemoModeDepthForTests } from './enterExitDemoMode';

describe('demo mode runtime flag', () => {
    it('keeps demo mode active until all nested entries exit', () => {
        resetDemoModeDepthForTests();

        expect(isDemoModeActive()).toBe(false);

        enterDemoMode();
        enterDemoMode();
        expect(isDemoModeActive()).toBe(true);

        exitDemoMode();
        expect(isDemoModeActive()).toBe(true);

        exitDemoMode();
        expect(isDemoModeActive()).toBe(false);
    });

    it('treats extra exits as no-ops', () => {
        resetDemoModeDepthForTests();

        exitDemoMode();

        expect(isDemoModeActive()).toBe(false);
    });
});
