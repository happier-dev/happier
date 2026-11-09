import { beforeEach, describe, expect, it, vi } from 'vitest';

const { alert } = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit')).createModalModuleMock({ spies: { alert } }).module);

import { t } from '@/text';
import { presentTerminalActionFailure } from './terminalActionFailure';

describe('presentTerminalActionFailure', () => {
    beforeEach(() => alert.mockClear());

    it('says a close that waits for approval is waiting, not that it failed', () => {
        presentTerminalActionFailure({ errorCode: 'approval_request_created', error: 'approval_request_created' });
        presentTerminalActionFailure({ errorCode: 'terminal_approval_cancellation_pending', error: 'terminal_approval_cancellation_pending' });
        expect(alert).toHaveBeenCalledTimes(2);
        expect(alert).toHaveBeenNthCalledWith(1, t('approvals.waitingForYou'));
        expect(alert).toHaveBeenNthCalledWith(2, t('approvals.waitingForYou'));
    });

    it('says why a refused split could not happen and what to do next', () => {
        presentTerminalActionFailure({ errorCode: 'terminal_split_unavailable', error: 'terminal_split_unavailable' });
        presentTerminalActionFailure({ errorCode: 'terminal_layout_unmeasured', error: 'terminal_layout_unmeasured' });
        expect(alert).toHaveBeenNthCalledWith(1, t('terminalWorkspace.splitRefused.noRoom'), t('terminalWorkspace.splitRefused.noRoomHint'));
        expect(alert).toHaveBeenNthCalledWith(2, t('terminalWorkspace.splitRefused.notReady'), t('terminalWorkspace.splitRefused.notReadyHint'));
        for (const [title] of alert.mock.calls) expect(title).not.toBe(t('terminalWorkspace.actionFailed'));
    });

    it('says nothing when the person cancelled the close they were asked about', () => {
        presentTerminalActionFailure({ errorCode: 'approval_canceled', error: 'approval_canceled' });
        expect(alert).not.toHaveBeenCalled();
    });

    it('keeps the generic failure for a real failure', () => {
        presentTerminalActionFailure({ errorCode: 'terminal_not_found', error: 'terminal_not_found' });
        presentTerminalActionFailure({});
        expect(alert).toHaveBeenNthCalledWith(1, t('terminalWorkspace.actionFailed'));
        expect(alert).toHaveBeenNthCalledWith(2, t('terminalWorkspace.actionFailed'));
    });
});
