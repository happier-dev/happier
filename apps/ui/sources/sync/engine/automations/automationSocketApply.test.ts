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

    it('prefers coalesced invalidation for automation update types only', () => {
        const invalidateAutomations = vi.fn();
        const invalidateAutomationsCoalesced = vi.fn();
        expect(applyAutomationSocketUpdate({
            updateType: 'automation-upsert',
            invalidateAutomations,
            invalidateAutomationsCoalesced,
        })).toBe(true);
        expect(invalidateAutomationsCoalesced).toHaveBeenCalledTimes(1);
        expect(invalidateAutomations).not.toHaveBeenCalled();

        expect(applyAutomationSocketUpdate({
            updateType: 'update-session',
            invalidateAutomations,
            invalidateAutomationsCoalesced,
        })).toBe(false);
        expect(invalidateAutomationsCoalesced).toHaveBeenCalledTimes(1);
        expect(invalidateAutomations).not.toHaveBeenCalled();
    });
});
