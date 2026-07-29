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
            status: 'refresh_failed_retryable',
            onDisconnect,
        });

        expect(actions.map((action) => action.id)).toContain('disconnect');
        actions.find((action) => action.id === 'disconnect')?.onPress?.();
        expect(onDisconnect).toHaveBeenCalledOnce();
    });

    it('does not offer destructive disconnect for reconnect-required records', () => {
        const actions = buildConnectedServiceAccountRowActions({
            kind: 'oauth',
            status: 'needs_reauth',
            onDisconnect: vi.fn(),
        });

        expect(actions.map((action) => action.id)).not.toContain('disconnect');
    });
});
