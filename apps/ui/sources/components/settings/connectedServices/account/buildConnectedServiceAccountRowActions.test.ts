import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceAccountRowActions } from './buildConnectedServiceAccountRowActions';

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('buildConnectedServiceAccountRowActions', () => {
    it('allows retryable refresh-failure account records to be disconnected', () => {
        const onDisconnect = vi.fn();

        const actions = buildConnectedServiceAccountRowActions({
            kind: 'oauth',
            onDisconnect,
        });

        expect(actions.map((action) => action.id)).toContain('disconnect');
        actions.find((action) => action.id === 'disconnect')?.onPress?.();
        expect(onDisconnect).toHaveBeenCalledOnce();
    });

    it('offers disconnect for reconnect-required records so the row matches the detail screen', () => {
        // The account DETAIL screen disconnects unconditionally. Gating the row
        // menu on credential usability made a broken (needs_reauth) account the
        // ONE account a user could not remove from the list — the exact record
        // most likely to need removing. The two surfaces now agree.
        const onDisconnect = vi.fn();

        const actions = buildConnectedServiceAccountRowActions({
            kind: 'oauth',
            onDisconnect,
        });

        expect(actions.map((action) => action.id)).toContain('disconnect');
        actions.find((action) => action.id === 'disconnect')?.onPress?.();
        expect(onDisconnect).toHaveBeenCalledOnce();
    });

    it('omits disconnect entirely when the caller supplies no disconnect handler', () => {
        // Authority stays with the caller: an action the screen is not permitted
        // to run is ABSENT, never a disabled affordance.
        const actions = buildConnectedServiceAccountRowActions({
            kind: 'oauth',
        });

        expect(actions.map((action) => action.id)).not.toContain('disconnect');
    });
});
