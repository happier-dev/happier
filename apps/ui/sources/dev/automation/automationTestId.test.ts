import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveAutomationAccessibilityLabel, resolveAutomationTestIdLabelEnabled } from './automationTestId';

describe('automationTestId', () => {
    const previousDev = (globalThis as any).__DEV__;
    const previousFlag = process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;

    beforeEach(() => {
        (globalThis as any).__DEV__ = true;
    });

    afterEach(() => {
        if (previousDev === undefined) delete (globalThis as any).__DEV__;
        else (globalThis as any).__DEV__ = previousDev;
        if (previousFlag === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;
        else process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS = previousFlag;
    });

    it('returns false when not explicitly enabled', () => {
        delete process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;
        expect(resolveAutomationTestIdLabelEnabled()).toBe(false);
    });

    it('prefers accessibilityLabel when disabled', () => {
        delete process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;
        expect(resolveAutomationAccessibilityLabel({ testID: 'x', accessibilityLabel: undefined })).toBeUndefined();
        expect(resolveAutomationAccessibilityLabel({ testID: 'x', accessibilityLabel: 'Real label' })).toBe('Real label');
    });

    it('prefers testID when enabled', () => {
        process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS = '1';
        expect(resolveAutomationAccessibilityLabel({ testID: 'welcome-create-account', accessibilityLabel: undefined })).toBe(
            'welcome-create-account',
        );
        expect(resolveAutomationAccessibilityLabel({ testID: undefined, accessibilityLabel: 'Real label' })).toBe('Real label');
    });
});
