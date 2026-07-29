import { describe, expect, it, vi } from 'vitest';

import { applyCurrentSessionPresentationCommand } from './applyCurrentSessionPresentationCommand';

const notifyCommand = {
    id: 'n1', clientId: 'client-1', kind: 'notify' as const, message: 'Done', severity: 'info' as const,
};

describe('applyCurrentSessionPresentationCommand', () => {
    it('rejects stale hosts and wrong clients without applying a one-shot', () => {
        const notify = vi.fn();
        expect(applyCurrentSessionPresentationCommand({
            sessionId: 's1', hostNonce: 'new-host', clientId: 'client-1', focusedSessionId: 's1',
            state: { v: 1, hostNonce: 'old-host', revision: 1, statuses: [], widgets: [], command: notifyCommand },
            notify,
            composer: null,
        })).toBeNull();
        expect(notify).not.toHaveBeenCalled();
    });

    it('applies a targeted notification and returns an exact acknowledgement', () => {
        const notify = vi.fn();
        expect(applyCurrentSessionPresentationCommand({
            sessionId: 's1', hostNonce: 'host-1', clientId: 'client-1', focusedSessionId: null,
            state: { v: 1, hostNonce: 'host-1', revision: 1, statuses: [], widgets: [], command: notifyCommand },
            notify,
            composer: null,
        })).toEqual({
            hostNonce: 'host-1', clientId: 'client-1', commandId: 'n1', status: 'applied',
        });
        expect(notify).toHaveBeenCalledWith({ sessionId: 's1', message: 'Done', severity: 'info' });
    });

    it('checks focused session and draft revision before replacing the composer', () => {
        const replace = vi.fn(() => 8);
        const state = {
            v: 1 as const,
            hostNonce: 'host-1',
            revision: 2,
            statuses: [],
            widgets: [],
            command: {
                id: 'c1', clientId: 'client-1', kind: 'composer.replace' as const,
                text: 'replacement', expectedDraftRevision: 7,
            },
        };
        expect(applyCurrentSessionPresentationCommand({
            sessionId: 's1', hostNonce: 'host-1', clientId: 'client-1', focusedSessionId: 'other',
            state, notify: vi.fn(), composer: { revision: 7, replace },
        })).toMatchObject({ status: 'conflict', draftRevision: 7 });
        expect(replace).not.toHaveBeenCalled();

        expect(applyCurrentSessionPresentationCommand({
            sessionId: 's1', hostNonce: 'host-1', clientId: 'client-1', focusedSessionId: 's1',
            state, notify: vi.fn(), composer: { revision: 7, replace },
        })).toMatchObject({ status: 'applied', draftRevision: 8 });
        expect(replace).toHaveBeenCalledWith('replacement', 7);
    });
});
