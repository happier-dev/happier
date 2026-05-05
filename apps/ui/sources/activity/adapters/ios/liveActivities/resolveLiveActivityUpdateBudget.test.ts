import { describe, expect, it } from 'vitest';

async function loadUpdateBudgetModule() {
    return import('./resolveLiveActivityUpdateBudget').catch(() => null);
}

describe('resolveLiveActivityUpdateBudget', () => {
    it('derives runtime visibility from AppState status', async () => {
        const updateBudget = await loadUpdateBudgetModule();
        expect(updateBudget).not.toBeNull();
        if (!updateBudget) return;

        expect(typeof updateBudget.resolveLiveActivityRuntimeVisibility).toBe('function');
        expect(updateBudget.resolveLiveActivityRuntimeVisibility({ appStateStatus: 'active' })).toBe('foreground_unlocked');
        expect(updateBudget.resolveLiveActivityRuntimeVisibility({ appStateStatus: 'inactive' })).toBe('background_or_locked');
        expect(updateBudget.resolveLiveActivityRuntimeVisibility({ appStateStatus: 'background' })).toBe('background_or_locked');
    });

    it('reports runtime-unavailable diagnostics without treating background or force-quit gaps as stopped activities', async () => {
        const updateBudget = await loadUpdateBudgetModule();
        expect(updateBudget).not.toBeNull();
        if (!updateBudget) return;

        expect(updateBudget.resolveLiveActivityRuntimeDiagnostics({
            appStateStatus: 'background',
            bridgeAvailable: true,
        })).toEqual({
            state: 'runtime_unavailable',
            reason: 'app_backgrounded_or_locked',
        });
        expect(updateBudget.resolveLiveActivityRuntimeDiagnostics({
            appStateStatus: 'active',
            bridgeAvailable: false,
        })).toEqual({
            state: 'runtime_unavailable',
            reason: 'native_bridge_unavailable',
        });
    });

    it('uses a fast local cadence while the app is foreground and unlocked', async () => {
        const updateBudget = await loadUpdateBudgetModule();
        expect(updateBudget).not.toBeNull();
        if (!updateBudget) return;

        const budget = updateBudget.resolveLiveActivityUpdateBudget({
            attentionState: 'thinking',
            runtimeVisibility: 'foreground_unlocked',
        });

        expect(budget).toEqual({
            template: 'quietFocus',
            apnsPriority: 5,
            minimumIntervalMs: 1_000,
        });
        expect(updateBudget.shouldApplyLiveActivityUpdate({
            budget,
            lastAppliedAtMs: 10_000,
            nowMs: 10_999,
        })).toBe(false);
        expect(updateBudget.shouldApplyLiveActivityUpdate({
            budget,
            lastAppliedAtMs: 10_000,
            nowMs: 11_000,
        })).toBe(true);
        expect(updateBudget.resolveLiveActivityUpdateDecision({
            budget,
            lastAppliedAtMs: 10_000,
            nowMs: 10_999,
        })).toEqual({
            shouldApply: false,
            reason: 'throttled',
            elapsedMs: 999,
            minimumIntervalMs: 1_000,
        });
    });

    it('throttles background quiet updates without turning them into interruptions', async () => {
        const updateBudget = await loadUpdateBudgetModule();
        expect(updateBudget).not.toBeNull();
        if (!updateBudget) return;

        const budget = updateBudget.resolveLiveActivityUpdateBudget({
            attentionState: 'unread',
            runtimeVisibility: 'background_or_locked',
        });

        expect(budget).toEqual({
            template: 'quietFocus',
            apnsPriority: 5,
            minimumIntervalMs: 30_000,
        });
    });

    it('keeps urgent background updates on the urgent template while preserving the 30 second floor', async () => {
        const updateBudget = await loadUpdateBudgetModule();
        expect(updateBudget).not.toBeNull();
        if (!updateBudget) return;

        const budget = updateBudget.resolveLiveActivityUpdateBudget({
            attentionState: 'permission_required',
            runtimeVisibility: 'background_or_locked',
        });

        expect(budget).toEqual({
            template: 'urgentAttention',
            apnsPriority: 10,
            minimumIntervalMs: 30_000,
        });
    });

    it('keeps urgent updates on the urgent template but caps APNs priority when frequent updates are disabled', async () => {
        const updateBudget = await loadUpdateBudgetModule();
        expect(updateBudget).not.toBeNull();
        if (!updateBudget) return;

        const budget = updateBudget.resolveLiveActivityUpdateBudget({
            attentionState: 'permission_required',
            runtimeVisibility: 'background_or_locked',
            frequentUpdates: 'disabled',
        });

        expect(budget).toEqual({
            template: 'urgentAttention',
            apnsPriority: 5,
            minimumIntervalMs: 30_000,
        });
    });
});
