import type { ComposerTransactionResultV1, ComposerTransactionV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { applyCurrentSessionPresentationCommand } from './applyCurrentSessionPresentationCommand';

const notifyCommand = {
    id: 'n1', clientId: 'client-1', kind: 'notify' as const, message: 'Done', severity: 'info' as const,
};

describe('applyCurrentSessionPresentationCommand', () => {
    it('rejects stale hosts and wrong clients without applying a one-shot', () => {
        const notify = vi.fn();
        const apply = vi.fn<() => ComposerTransactionResultV1>();
        expect(applyCurrentSessionPresentationCommand({
            sessionId: 's1', hostNonce: 'new-host', clientId: 'client-1', focusedSessionId: 's1',
            state: { v: 1, hostNonce: 'old-host', revision: 1, statuses: [], widgets: [], command: notifyCommand },
            notify,
            composer: { revision: 1, apply },
        })).toBeNull();
        expect(notify).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
    });

    it('applies a targeted notification fire-and-forget without synthesizing a transaction acknowledgement', () => {
        const notify = vi.fn();
        expect(applyCurrentSessionPresentationCommand({
            sessionId: 's1', hostNonce: 'host-1', clientId: 'client-1', focusedSessionId: null,
            state: { v: 1, hostNonce: 'host-1', revision: 1, statuses: [], widgets: [], command: notifyCommand },
            notify,
            composer: null,
        })).toEqual({
            ack: null,
        });
        expect(notify).toHaveBeenCalledWith({ sessionId: 's1', message: 'Done', severity: 'info' });
    });

    it('checks the focused session then delegates the exact transaction once to the canonical composer owner', () => {
        const apply = vi.fn<(transaction: ComposerTransactionV1) => ComposerTransactionResultV1>(
            () => ({ status: 'applied', revision: 8 }),
        );
        const composer = { revision: 7, apply };
        const state = {
            v: 1 as const,
            hostNonce: 'host-1',
            revision: 2,
            statuses: [],
            widgets: [],
            command: {
                id: 'c1', clientId: 'client-1', kind: 'composer.replace' as const,
                transaction: {
                    expectedRevision: 7,
                    operations: [{ kind: 'text.set' as const, text: 'replacement' }],
                },
            },
        };
        expect(applyCurrentSessionPresentationCommand({
            sessionId: 's1', hostNonce: 'host-1', clientId: 'client-1', focusedSessionId: 'other',
            state, notify: vi.fn(), composer,
        })).toEqual({
            ack: {
                hostNonce: 'host-1',
                clientId: 'client-1',
                commandId: 'c1',
                result: { status: 'notEditable' },
            },
        });
        expect(apply).not.toHaveBeenCalled();

        expect(applyCurrentSessionPresentationCommand({
            sessionId: 's1', hostNonce: 'host-1', clientId: 'client-1', focusedSessionId: 's1',
            state, notify: vi.fn(), composer,
        })).toEqual({
            ack: {
                hostNonce: 'host-1',
                clientId: 'client-1',
                commandId: 'c1',
                result: { status: 'applied', revision: 8 },
            },
        });
        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledWith(state.command.transaction);
    });
});
