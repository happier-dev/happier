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
        for (const target of [
            { hostNonce: 'new-host', clientId: 'client-1' },
            { hostNonce: 'old-host', clientId: 'another-client' },
        ]) {
            expect(applyCurrentSessionPresentationCommand({
                ...target, isCurrentSession: true,
                state: { v: 1, hostNonce: 'old-host', revision: 1, statuses: [], widgets: [], command: notifyCommand },
                notify,
                composer: { revision: 1, apply },
            })).toBeNull();
        }
        expect(notify).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
    });

    it('applies a targeted notification fire-and-forget without synthesizing a transaction acknowledgement', () => {
        const notify = vi.fn();
        expect(applyCurrentSessionPresentationCommand({
            hostNonce: 'host-1', clientId: 'client-1', isCurrentSession: false,
            state: { v: 1, hostNonce: 'host-1', revision: 1, statuses: [], widgets: [], command: notifyCommand },
            notify,
            composer: null,
        })).toEqual({
            ack: null,
        });
        expect(notify).toHaveBeenCalledWith({ message: 'Done', severity: 'info' });
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
            hostNonce: 'host-1', clientId: 'client-1', isCurrentSession: false,
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
            hostNonce: 'host-1', clientId: 'client-1', isCurrentSession: true,
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

    it('applies a Board presentation intent only to the exact focused mounted Session adapter', () => {
        const applyPresentationIntent = vi.fn(() => ({ status: 'applied' as const }));
        const state = {
            v: 1 as const,
            hostNonce: 'host-1',
            revision: 3,
            statuses: [],
            widgets: [],
            command: {
                id: 'p1', clientId: 'client-1', kind: 'presentation.apply' as const,
                intent: { kind: 'board.item.reveal' as const, widgetId: 'note-1' },
            },
        };
        expect(applyCurrentSessionPresentationCommand({
            hostNonce: 'host-1', clientId: 'client-1', isCurrentSession: false,
            state, notify: vi.fn(), composer: null,
            presentation: { apply: applyPresentationIntent },
        })).toEqual({
            ack: { hostNonce: 'host-1', clientId: 'client-1', commandId: 'p1', result: { status: 'notCurrent' } },
        });
        expect(applyPresentationIntent).not.toHaveBeenCalled();

        expect(applyCurrentSessionPresentationCommand({
            hostNonce: 'host-1', clientId: 'client-1', isCurrentSession: true,
            state, notify: vi.fn(), composer: null,
            presentation: { apply: applyPresentationIntent },
        })).toEqual({
            ack: { hostNonce: 'host-1', clientId: 'client-1', commandId: 'p1', result: { status: 'applied' } },
        });
        expect(applyPresentationIntent).toHaveBeenCalledTimes(1);
        expect(applyPresentationIntent).toHaveBeenCalledWith(state.command.intent);
    });

    it('returns the typed unavailable result when the exact current Session has no presentation adapter', () => {
        const state = {
            v: 1 as const,
            hostNonce: 'host-1',
            revision: 3,
            statuses: [],
            widgets: [],
            command: {
                id: 'p-unavailable', clientId: 'client-1', kind: 'presentation.apply' as const,
                intent: { kind: 'companion.show' as const },
            },
        };

        expect(applyCurrentSessionPresentationCommand({
            hostNonce: 'host-1', clientId: 'client-1', isCurrentSession: true,
            state, notify: vi.fn(), composer: null, presentation: null,
        })).toEqual({
            ack: {
                hostNonce: 'host-1',
                clientId: 'client-1',
                commandId: 'p-unavailable',
                result: { status: 'unavailable' },
            },
        });
    });
});
