import { describe, expect, it, vi } from 'vitest';

import {
    clickScopedButtonByTestIdOrRole,
    type CountableClickableLocator,
    type CountableRoleScope,
} from './clickScopedButtonByTestIdOrRole';

function createLocator(sequence: number[]): CountableClickableLocator & { clickSpy: ReturnType<typeof vi.fn> } {
    let index = 0;
    const clickSpy = vi.fn(async () => {});
    return {
        count: async () => {
            const value = sequence[Math.min(index, sequence.length - 1)] ?? 0;
            index += 1;
            return value;
        },
        click: clickSpy,
        clickSpy,
    };
}

function createScope(testIdCounts: number[], roleCounts: number[]): Readonly<{
    scope: CountableRoleScope;
    testIdLocator: ReturnType<typeof createLocator>;
    roleLocator: ReturnType<typeof createLocator>;
    getByRoleSpy: ReturnType<typeof vi.fn>;
}> {
    const testIdLocator = createLocator(testIdCounts);
    const roleLocator = createLocator(roleCounts);
    const getByRoleSpy = vi.fn(() => roleLocator);
    return {
        scope: {
            getByTestId: () => testIdLocator,
            getByRole: getByRoleSpy,
        },
        testIdLocator,
        roleLocator,
        getByRoleSpy,
    };
}

describe('clickScopedButtonByTestIdOrRole', () => {
    it('prefers the testID locator when it is available', async () => {
        const { scope, testIdLocator, roleLocator } = createScope([1], [1]);

        const result = await clickScopedButtonByTestIdOrRole({
            scope,
            testId: 'session-rightpanel-tab-files',
            roleName: 'Files',
            timeoutMs: 500,
        });

        expect(result).toBe('testId');
        expect(testIdLocator.clickSpy).toHaveBeenCalledTimes(1);
        expect(roleLocator.clickSpy).toHaveBeenCalledTimes(0);
    });

    it('falls back to the role locator when the testID locator is missing', async () => {
        const { scope, testIdLocator, roleLocator } = createScope([0], [1]);

        const result = await clickScopedButtonByTestIdOrRole({
            scope,
            testId: 'session-rightpanel-tab-files',
            roleName: 'Files',
            timeoutMs: 500,
        });

        expect(result).toBe('role');
        expect(testIdLocator.clickSpy).toHaveBeenCalledTimes(0);
        expect(roleLocator.clickSpy).toHaveBeenCalledTimes(1);
    });

    it('uses exact accessible-name matching for the role fallback', async () => {
        const { scope, getByRoleSpy } = createScope([0], [1]);

        await clickScopedButtonByTestIdOrRole({
            scope,
            testId: 'session-rightpanel-tab-files',
            roleName: 'Files',
            timeoutMs: 500,
        });

        expect(getByRoleSpy).toHaveBeenCalledWith('button', { name: 'Files', exact: true });
    });

    it('waits for the preferred locator to appear during lazy mount', async () => {
        const { scope, testIdLocator, roleLocator } = createScope([0, 0, 1], [0, 0, 1]);
        let nowMs = 0;

        const result = await clickScopedButtonByTestIdOrRole({
            scope,
            testId: 'session-rightpanel-tab-files',
            roleName: 'Files',
            timeoutMs: 500,
            pollIntervalMs: 100,
            getNowMs: () => nowMs,
            sleep: async (delayMs) => {
                nowMs += delayMs;
            },
        });

        expect(result).toBe('testId');
        expect(testIdLocator.clickSpy).toHaveBeenCalledTimes(1);
        expect(roleLocator.clickSpy).toHaveBeenCalledTimes(0);
    });
});
