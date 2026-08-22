import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const standingInputs = vi.hoisted(() => ({
    placementMode: 'global' as 'off' | 'global' | 'withinGroups',
    defaultStanding: false,
    overridesBySessionKey: {} as Readonly<Record<string, boolean>>,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: createUseSettingMock({
                fallback: (key) => (key === 'sessionListAttentionStandingDefaultV1'
                    ? standingInputs.defaultStanding
                    : standingInputs.placementMode),
            }),
        },
    });
});

describe('useSessionAttentionStandingInputs', () => {
    afterEach(() => {
        standardCleanup();
        standingInputs.placementMode = 'global';
        standingInputs.defaultStanding = false;
        standingInputs.overridesBySessionKey = {};
    });

    it('keeps the policy identity across an unrelated organization projection rebuild', async () => {
        // The organization view state re-derives `attentionStandingOverridesBySessionKey` with
        // `Object.fromEntries` on every projection build, so a pin, a tag or a folder edit hands
        // this hook a brand-new record holding the same standings. The policy is compared by
        // identity in the row-model gate, so a fresh object there rebuilds every row view model
        // for traffic that changed no standing at all. Pin defends the same seam by content in
        // `resolveSessionListOrderingPersistenceState`.
        standingInputs.overridesBySessionKey = { 'server-a:s1': true };

        const { useSessionAttentionStandingInputs } = await import('./useSessionAttentionStandingInputs');
        const hook = await renderHook(() => useSessionAttentionStandingInputs(standingInputs.overridesBySessionKey));
        const first = hook.getCurrent();

        standingInputs.overridesBySessionKey = { 'server-a:s1': true };
        await hook.rerender();

        expect(hook.getCurrent()?.policy).toBe(first?.policy);
    });

    it('mints a new policy when a standing actually changes', async () => {
        standingInputs.overridesBySessionKey = { 'server-a:s1': true };

        const { useSessionAttentionStandingInputs } = await import('./useSessionAttentionStandingInputs');
        const hook = await renderHook(() => useSessionAttentionStandingInputs(standingInputs.overridesBySessionKey));
        const first = hook.getCurrent();

        standingInputs.overridesBySessionKey = { 'server-a:s1': false };
        await hook.rerender();

        expect(hook.getCurrent()?.policy).not.toBe(first?.policy);
        expect(hook.getCurrent()?.policy.overridesBySessionKey).toEqual({ 'server-a:s1': false });
    });

    it('mints a new policy when the account default flips', async () => {
        standingInputs.overridesBySessionKey = {};

        const { useSessionAttentionStandingInputs } = await import('./useSessionAttentionStandingInputs');
        const hook = await renderHook(() => useSessionAttentionStandingInputs(standingInputs.overridesBySessionKey));
        const first = hook.getCurrent();

        standingInputs.defaultStanding = true;
        await hook.rerender();

        expect(hook.getCurrent()?.policy).not.toBe(first?.policy);
        expect(hook.getCurrent()?.policy.defaultStanding).toBe(true);
    });

    it('hides the action while the attention band is off', async () => {
        standingInputs.placementMode = 'off';

        const { useSessionAttentionStandingInputs } = await import('./useSessionAttentionStandingInputs');
        const hook = await renderHook(() => useSessionAttentionStandingInputs(standingInputs.overridesBySessionKey));

        expect(hook.getCurrent()?.actionEnabled).toBe(false);
        expect(hook.getCurrent()?.placementMode).toBe('off');
    });
});
