import { describe, expect, it, vi } from 'vitest';

import { applyAutomationSocketUpdate, isAutomationSocketUpdateType } from './automationSocketApply';

describe('automationSocketApply', () => {
    it('recognizes automation update types', () => {
        expect(isAutomationSocketUpdateType('automation-upsert')).toBe(true);
        expect(isAutomationSocketUpdateType('automation-delete')).toBe(true);
        expect(isAutomationSocketUpdateType('automation-run-updated')).toBe(true);
        expect(isAutomationSocketUpdateType('automation-assignment-updated')).toBe(true);
        expect(isAutomationSocketUpdateType('new-session')).toBe(false);
    });

    it('invalidates automations for automation update types only', () => {
        const invalidateAutomations = vi.fn();
        expect(applyAutomationSocketUpdate({
            updateType: 'automation-upsert',
            invalidateAutomations,
        })).toBe(true);
        expect(invalidateAutomations).toHaveBeenCalledTimes(1);

        expect(applyAutomationSocketUpdate({
            updateType: 'update-session',
            invalidateAutomations,
        })).toBe(false);
        expect(invalidateAutomations).toHaveBeenCalledTimes(1);
    });
});
