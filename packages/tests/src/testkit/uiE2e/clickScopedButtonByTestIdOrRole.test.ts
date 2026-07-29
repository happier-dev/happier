import { describe, expect, it, vi } from 'vitest';

import {
    clickScopedButtonByTestIdOrRole,
    type CountableClickableLocator,
    type CountableRoleScope,
} from './clickScopedButtonByTestIdOrRole';

function createLocator(
    sequence: number[],
    options?: Readonly<{
        visibleSequence?: boolean[];
        ariaSelectedSequence?: Array<string | null>;
    }>,
): CountableClickableLocator & {
    clickSpy: ReturnType<typeof vi.fn>;
    getAttributeSpy: ReturnType<typeof vi.fn>;
} {
    let index = 0;
    let visibleIndex = 0;
    let ariaSelectedIndex = 0;
    const clickSpy = vi.fn(async () => {});
    const getAttributeSpy = vi.fn(async (name: string) => {
        if (name !== 'aria-selected') return null;
        const values = options?.ariaSelectedSequence ?? [null];
        const value = values[Math.min(ariaSelectedIndex, values.length - 1)] ?? null;
        ariaSelectedIndex += 1;
        return value;
    });
    return {
        count: async () => {
            const value = sequence[Math.min(index, sequence.length - 1)] ?? 0;
            index += 1;
            return value;
        },
        isVisible: async () => {
            const values = options?.visibleSequence ?? [true];
            const value = values[Math.min(visibleIndex, values.length - 1)] ?? false;
            visibleIndex += 1;
            return value;
        },
        getAttribute: getAttributeSpy,
        click: clickSpy,
        clickSpy,
        getAttributeSpy,
    };
}

function createScope(
    testIdCounts: number[],
    roleCounts: number[],
    options?: Readonly<{
        testIdVisibleSequence?: boolean[];
        roleVisibleSequence?: boolean[];
        testIdAriaSelectedSequence?: Array<string | null>;
        roleAriaSelectedSequence?: Array<string | null>;
    }>,
): Readonly<{
    scope: CountableRoleScope;
    testIdLocator: ReturnType<typeof createLocator>;
    roleLocator: ReturnType<typeof createLocator>;
    getByRoleSpy: ReturnType<typeof vi.fn>;
}> {
    const testIdLocator = createLocator(testIdCounts, {
        visibleSequence: options?.testIdVisibleSequence,
        ariaSelectedSequence: options?.testIdAriaSelectedSequence,
    });
    const roleLocator = createLocator(roleCounts, {
        visibleSequence: options?.roleVisibleSequence,
        ariaSelectedSequence: options?.roleAriaSelectedSequence,
    });
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

    it('falls back to the visible role locator when the testID candidate is hidden', async () => {
        const { scope, testIdLocator, roleLocator } = createScope([1], [1], {
            testIdVisibleSequence: [false],
            roleVisibleSequence: [true],
        });

        const result = await clickScopedButtonByTestIdOrRole({
            scope,
            testId: 'session-rightpanel-tab:files',
            roleName: 'Files',
            timeoutMs: 500,
        });

        expect(result).toBe('role');
        expect(testIdLocator.clickSpy).toHaveBeenCalledTimes(0);
        expect(roleLocator.clickSpy).toHaveBeenCalledTimes(1);
    });

    it('waits for the requested tab to become selected after clicking it', async () => {
        const { scope, testIdLocator, getByRoleSpy } = createScope([1], [1], {
            testIdAriaSelectedSequence: ['false', 'false', 'true'],
        });
        let nowMs = 0;

        const result = await clickScopedButtonByTestIdOrRole({
            scope,
            testId: 'session-rightpanel-tab:files',
            roleName: 'Files',
            role: 'tab',
            expectedAriaSelected: true,
            timeoutMs: 500,
            pollIntervalMs: 100,
            getNowMs: () => nowMs,
            sleep: async (delayMs) => {
                nowMs += delayMs;
            },
        });

        expect(result).toBe('testId');
        expect(getByRoleSpy).toHaveBeenCalledWith('tab', { name: 'Files', exact: true });
        expect(testIdLocator.getAttributeSpy).toHaveBeenCalledTimes(3);
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
