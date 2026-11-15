import { describe, expect, it, vi } from 'vitest';

const { alert } = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert } }).module;
});

import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';
import { alertApprovalFailure, assertApprovalExecutionSucceeded, presentRecordedApprovalFailure } from './useApprovalDecisionHandler';

describe('approval decision execution outcome', () => {
    it('presents an unconfirmed managed Delete through the shared Action failure presenter', async () => {
        const { ActionFailureCauseV1Schema, projectUnexpectedActionFailureV1 } = await import('@happier-dev/protocol/actions/actionExecutionResult');
        const { presentActionExecutionFailure } = await import('@/sync/ops/actions/resolveActionExecutionFailureMessage');
        const failure = { ...projectUnexpectedActionFailureV1(null, 'delete-request'),
            failureCause: ActionFailureCauseV1Schema.parse({ phase: 'managed.controller.admit_control', errorClass: 'ManagedMachineControllerError',
                errorCode: 'managed_controller_request_failed', httpStatus: 200 }) };
        const presentation = presentActionExecutionFailure(failure);
        expect(presentation.reason).not.toBe(t('approvals.decisionError'));
        alert.mockClear();
        alertApprovalFailure(new HappyError('private transport diagnostic', false,
            { code: failure.errorCode, failureCause: failure.failureCause }));
        expect(alert.mock.calls[0]?.[1]).toBe(presentation.reason);
    });
    it('keeps confirmed execution cancellation quiet without treating the cancelled effect as success', () => {
        let cancelled: unknown;
        try {
            assertApprovalExecutionSucceeded({ executedAtMs: 1, ok: false, errorCode: 'cancelled', error: 'cancelled' });
        } catch (error) { cancelled = error; }
        expect(cancelled).toBeInstanceOf(HappyError);
        expect(cancelled).toMatchObject({ code: 'cancelled' });
        alert.mockClear();
        alertApprovalFailure(cancelled);
        expect(alert).not.toHaveBeenCalled();
    });
    it('keeps unconfirmed cancellation and unknown execution outcomes visible', () => {
        alert.mockClear();
        alertApprovalFailure(new HappyError('cancelled', false, { code: 'cancelled' }));
        expect(alert).toHaveBeenCalledTimes(1);

        let unknownOutcome: unknown;
        try {
            assertApprovalExecutionSucceeded({ executedAtMs: 1, ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
        } catch (error) { unknownOutcome = error; }
        alert.mockClear();
        alertApprovalFailure(unknownOutcome);
        expect(alert).toHaveBeenCalledTimes(1);
    });
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

    it.each(['target_changed', 'action_request_input_conflict'])('keeps a recorded %s failure available in the alert Technical details', errorCode => {
        // RU2 R52: a confidential entry failure must retain its typed cause in the alert too.
        let recorded: unknown;
        try {
            assertApprovalExecutionSucceeded({ executedAtMs: 1, ok: false, errorCode, error: errorCode });
        } catch (error) { recorded = error; }
        alert.mockClear();
        alertApprovalFailure(recorded);
        expect(alert).toHaveBeenCalledTimes(1);
        const [, recordedMessage, recordedButtons] = alert.mock.calls[0]!;
        expect(recordedMessage).not.toContain(errorCode);
        const recordedDetails = (recordedButtons as Array<{ text: string; onPress?: () => void }> | undefined)
            ?.find(button => button.text === t('approvals.technicalDetails'));
        expect(recordedDetails).toBeTruthy();
        recordedDetails!.onPress!();
        expect(alert.mock.calls[1]![1]).toBe(errorCode);

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
    it('names an approved clone refused for agent isolation instead of saying no reason was recorded', () => {
        // Recorded #151 projects.open execution (request replay151-eg-clone): typed refusal, no prose.
        const presented = presentRecordedApprovalFailure({ errorCode: 'agent_isolation_unavailable', error: 'agent_isolation_unavailable',
            details: { kind: 'refused', code: 'agent_isolation_unavailable', effectAttempted: false,
                failureCause: { phase: 'projects.open', errorClass: 'Error', errorCode: 'agent_isolation_unavailable', httpStatus: null } },
            failureCause: { phase: 'projects.open', errorClass: 'Error', errorCode: 'agent_isolation_unavailable', httpStatus: null } });
        expect(presented).toEqual({ reason: t('errors.agentIsolationUnavailable'), code: 'agent_isolation_unavailable' });
    });
});
