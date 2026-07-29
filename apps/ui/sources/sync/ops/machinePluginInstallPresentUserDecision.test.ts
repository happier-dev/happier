import { describe, expect, it, vi } from 'vitest';

import { decideMachinePluginInstallReviewAsPresentUser } from './machinePluginInstallPresentUserDecision.mjs';

describe('decideMachinePluginInstallReviewAsPresentUser', () => {
    it('mints affirmative evidence only after confirmation and a current-authority recheck', async () => {
        const order: string[] = [];
        const callAuthenticatedPrivateRpc = vi.fn(async (_method: string, _payload: unknown) => {
            order.push('send');
            return { kind: 'committed', pluginId: 'acme.plugin' };
        });

        await expect(decideMachinePluginInstallReviewAsPresentUser({
            pendingChangeId: 'pending-1',
            confirmPresentUser: async () => {
                order.push('confirm');
                return [{ accessId: 'workspace', selected: false }];
            },
            isAuthorityCurrent: () => {
                order.push('authority');
                return true;
            },
            callAuthenticatedPrivateRpc,
            createInteractionId: () => {
                order.push('evidence');
                return 'interaction-1';
            },
            nowMs: () => 42,
        })).resolves.toEqual({ kind: 'committed', pluginId: 'acme.plugin' });

        expect(order).toEqual(['confirm', 'authority', 'evidence', 'send']);
        expect(callAuthenticatedPrivateRpc).toHaveBeenCalledWith(
            'daemon.plugins.install.review.decide',
            {
                v: 1,
                pendingChangeId: 'pending-1',
                decision: 'installAndTrust',
                actorEvidence: {
                    kind: 'authenticatedLocalUser',
                    interactionId: 'interaction-1',
                    occurredAtMs: 42,
                },
                optionalSelections: [{ accessId: 'workspace', selected: false }],
            },
        );
    });

    it('does not mint evidence or send when authority changes during confirmation', async () => {
        const createInteractionId = vi.fn(() => 'must-not-be-created');
        const callAuthenticatedPrivateRpc = vi.fn();

        await expect(decideMachinePluginInstallReviewAsPresentUser({
            pendingChangeId: 'pending-1',
            confirmPresentUser: async () => [],
            isAuthorityCurrent: () => false,
            callAuthenticatedPrivateRpc,
            createInteractionId,
            nowMs: () => 42,
        })).rejects.toThrow('authority changed');

        expect(createInteractionId).not.toHaveBeenCalled();
        expect(callAuthenticatedPrivateRpc).not.toHaveBeenCalled();
    });

    it('turns declined confirmation into private cancellation without affirmative evidence', async () => {
        const createInteractionId = vi.fn(() => 'must-not-be-created');
        const callAuthenticatedPrivateRpc = vi.fn(async () => ({ kind: 'cancelled' }));

        await expect(decideMachinePluginInstallReviewAsPresentUser({
            pendingChangeId: 'pending-1',
            confirmPresentUser: async () => null,
            isAuthorityCurrent: () => true,
            callAuthenticatedPrivateRpc,
            createInteractionId,
            nowMs: () => 42,
        })).resolves.toEqual({ kind: 'cancelled' });

        expect(createInteractionId).not.toHaveBeenCalled();
        expect(callAuthenticatedPrivateRpc).toHaveBeenCalledWith(
            'daemon.plugins.install.review.decide',
            {
                v: 1,
                pendingChangeId: 'pending-1',
                decision: 'cancel',
            },
        );
    });
});
