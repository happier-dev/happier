import { describe, expect, it, vi } from 'vitest';

const { alert } = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert } }).module;
});

import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';
import { alertApprovalFailure, assertApprovalExecutionSucceeded } from './useApprovalDecisionHandler';

describe('approval decision execution outcome', () => {
    it.each(['database_transaction_timeout', 'unavailable'])('shows an uncertain %s decision next step and discloses its cause without private payloads', errorCode => {
        alert.mockClear();
        alertApprovalFailure(new HappyError('private transport text', false, { code: 'unavailable',
            failureCause: { phase: 'approval.request.decide', errorClass: 'HttpStatusError',
                errorCode, httpStatus: 503 },
            details: { reason: 'database_transaction_timeout', token: 'PRIVATE_TOKEN', payload: { text: 'PRIVATE_DRAFT' } },
        }));
        const [, message, buttons] = alert.mock.calls[0]!;
        expect(message).toBe(t('errors.scmOutcomeUnknown'));
        const details = (buttons as Array<{ text: string; onPress?: () => void }>).find(button => button.text === t('approvals.technicalDetails'));
        details!.onPress!();
        expect(JSON.parse(alert.mock.calls[1]![1])).toMatchObject({ code: 'unavailable', phase: 'approval.request.decide',
            errorClass: 'HttpStatusError', errorCode, httpStatus: 503 });
        expect(JSON.stringify(alert.mock.calls)).not.toMatch(/PRIVATE_TOKEN|PRIVATE_DRAFT|private transport text/);
    });
    it('surfaces a recorded execution failure instead of accepting the decision as success', () => {
        const execution = {
            executedAtMs: 1,
            ok: false as const,
            errorCode: 'target_unavailable',
            error: 'Filesystem target is unavailable',
        };
        expect(() => assertApprovalExecutionSucceeded(execution)).toThrowError(HappyError);
        try {
            assertApprovalExecutionSucceeded(execution);
        } catch (error) {
            expect(error).toMatchObject({ code: 'target_unavailable', message: 'Filesystem target is unavailable' });
        }
    });

    it('alerts a failed decision in words, with its typed code only behind a deliberate Technical details', () => {
        // A recorded effect failure: the card and page already hold its code in their own Details.
        let recorded: unknown;
        try {
            assertApprovalExecutionSucceeded({ executedAtMs: 1, ok: false, errorCode: 'action_request_input_conflict', error: 'action_request_input_conflict' });
        } catch (error) { recorded = error; }
        alert.mockClear();
        alertApprovalFailure(recorded);
        expect(alert).toHaveBeenCalledTimes(1);
        const [, recordedMessage, recordedButtons] = alert.mock.calls[0]!;
        expect(recordedMessage).not.toContain('action_request_input_conflict');
        expect(recordedButtons).toBeUndefined();

        // A decision that couldn't be saved has no page Details: its code waits behind one button.
        alert.mockClear();
        alertApprovalFailure(new HappyError('private transport detail', false, { code: 'approval_origin_unavailable' }));
        const [, message, buttons] = alert.mock.calls[0]!;
        expect(message).toBe(t('approvals.decisionError'));
        const details = (buttons as Array<{ text: string; onPress?: () => void }>).find(button => button.text === t('approvals.technicalDetails'));
        expect(details).toBeTruthy();
        details!.onPress!();
        expect(alert.mock.calls[1]![1]).toBe('approval_origin_unavailable');
    });
});
