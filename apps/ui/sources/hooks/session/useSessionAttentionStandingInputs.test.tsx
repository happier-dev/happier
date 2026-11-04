import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { storage } from '@/sync/domains/state/storageStore';
import { useSessionAttentionStandingInputs } from './useSessionAttentionStandingInputs';

let previousState = storage.getState();
let overridesBySessionKey: Readonly<Record<string, boolean>> = {};

describe('useSessionAttentionStandingInputs', () => {
    beforeEach(() => {
        previousState = storage.getState();
        storage.setState({ settings: { ...previousState.settings,
            sessionListAttentionPlacementV1: 'both', sessionListAttentionStandingDefaultV1: false } });
    });
    afterEach(() => {
        standardCleanup();
        storage.setState(previousState);
        overridesBySessionKey = {};
    });

    it('keeps the policy identity across an unrelated organization projection rebuild', async () => {
        // The organization view state re-derives `attentionStandingOverridesBySessionKey` with
        // `Object.fromEntries` on every projection build, so a pin, a tag or a folder edit hands
        // this hook a brand-new record holding the same standings. The policy is compared by
        // identity in the row-model gate, so a fresh object there rebuilds every row view model
        // for traffic that changed no standing at all. Pin defends the same seam by content in
        // `resolveSessionListOrderingPersistenceState`.
        overridesBySessionKey = { 'server-a:s1': true };

        const hook = await renderHook(() => useSessionAttentionStandingInputs(overridesBySessionKey));
        const first = hook.getCurrent();

        overridesBySessionKey = { 'server-a:s1': true };
        await hook.rerender();

        expect(hook.getCurrent()?.policy).toBe(first?.policy);
    });

    it('mints a new policy when a standing actually changes', async () => {
        overridesBySessionKey = { 'server-a:s1': true };

        const hook = await renderHook(() => useSessionAttentionStandingInputs(overridesBySessionKey));
        const first = hook.getCurrent();

        overridesBySessionKey = { 'server-a:s1': false };
        await hook.rerender();

        expect(hook.getCurrent()?.policy).not.toBe(first?.policy);
        expect(hook.getCurrent()?.policy.overridesBySessionKey).toEqual({ 'server-a:s1': false });
    });

    it('mints a new policy when the account default flips', async () => {
        const hook = await renderHook(() => useSessionAttentionStandingInputs(overridesBySessionKey));
        const first = hook.getCurrent();

        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings, sessionListAttentionStandingDefaultV1: true } });
        });

        expect(hook.getCurrent()?.policy).not.toBe(first?.policy);
        expect(hook.getCurrent()?.policy.defaultStanding).toBe(true);
    });

    it('hides the action while the attention band is off', async () => {
        storage.setState({ settings: { ...storage.getState().settings, sessionListAttentionPlacementV1: 'inPlace' } });
        const hook = await renderHook(() => useSessionAttentionStandingInputs(overridesBySessionKey));

        expect(hook.getCurrent()?.actionEnabled).toBe(false);
        expect(hook.getCurrent()?.placementMode).toBe('inPlace');
    });
});
