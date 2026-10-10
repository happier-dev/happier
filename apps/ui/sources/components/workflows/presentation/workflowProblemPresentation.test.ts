import { describe, expect, it, vi } from 'vitest';

import { WORKFLOW_OPERATION_ERROR_CODES_V1 } from '@happier-dev/protocol';

import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from './workflowRunDisplayName';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

import {
    resolveWorkflowOperationUnavailableReason,
    resolveWorkflowProblemPresentation,
    resolveWorkflowsUnavailablePresentation,
} from './workflowProblemPresentation';

function actionError(rawCode: string | null, message = 'server-internal reason'): WorkflowActionError {
    return new WorkflowActionError({ message, rawCode });
}

/**
 * One mapping, every workflow surface. The library, the editor, Run detail and
 * the availability gate all read this module, so a closed Protocol code can
 * never reach a person as prose the server chose or as the identifier itself.
 */
describe('workflowProblemPresentation', () => {
    it('keeps unreadable history, encryption setup, key waiting and storage recovery distinct', () => {
        const states = [
            ['history_not_readable', 'none', 'alert'],
            ['encryption_setup_required', 'settings', 'alert'],
            ['waiting_for_keys', 'retry', 'status'],
            ['storage_unavailable', 'retry', 'alert'],
        ] as const;
        const messages = new Set<string>();
        for (const [code, repair, accessibilitySemantics] of states) {
            const problem = resolveWorkflowProblemPresentation(actionError(code));
            expect(problem).toMatchObject({ code, repair, accessibilitySemantics });
            messages.add(problem.message);
        }
        expect(messages.size).toBe(4);
    });
    it('keeps the same typed unreadable state in list names and exact Run recovery', () => {
        for (const reason of ['history_not_readable', 'encryption_setup_required', 'waiting_for_keys', 'storage_unavailable'] as const) {
            const name = resolveWorkflowRunDisplayName({ kind: 'unavailable', reason });
            expect(name).toMatchObject({ kind: 'unavailable', reason });
            expect(formatWorkflowRunDisplayName(name)).toBe(resolveWorkflowProblemPresentation(actionError(reason)).title);
        }
        expect(formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName({ kind: 'available', value: { title: 'My known run' } })))
            .toBe('My known run');
    });
    it('explains unavailable header content from the typed owner reason', () => {
        const error = new WorkflowActionError({ rawCode: 'content_unavailable', message: 'private implementation text',
            failure: { ok: false, errorCode: 'content_unavailable', error: 'workflow_definition_content_unavailable',
                details: { reason: 'invalid_header' } } });
        expect(resolveWorkflowProblemPresentation(error)).toMatchObject({
            code: 'content_unavailable', title: 'common.unavailable', message: 'workflows.contentReasons.invalidHeader', repair: 'none',
        });
    });
    it('maps every closed operation code to localized copy rather than the code or the server sentence', () => {
        for (const code of WORKFLOW_OPERATION_ERROR_CODES_V1) {
            const presentation = resolveWorkflowProblemPresentation(actionError(code));

            expect(presentation.code).toBe(code);
            expect(presentation.message).toMatch(/^(workflows|errors)\./);
            expect(presentation.message).not.toContain(code);
            expect(presentation.message).not.toContain('server-internal reason');
            expect(presentation.title).not.toContain(code);
        }
    });

    it('gives each materially different situation its own state rather than one blanket failure', () => {
        const distinct = new Set(
            WORKFLOW_OPERATION_ERROR_CODES_V1.map(
                (code) => resolveWorkflowProblemPresentation(actionError(code)).message,
            ),
        );

        // Codes are deliberately grouped when the person's situation and repair
        // are identical, but a single bucket would be the discarded-code defect
        // in a new costume.
        expect(distinct.size).toBeGreaterThanOrEqual(12);
    });

    /**
     * `workflow_outcome_unresolved` means Happier cannot yet prove the previous
     * input stopped. Showing the identifier told the person nothing and no
     * acknowledgement can bypass it, so the copy has to say what is actually
     * being waited on.
     */
    it('never exposes workflow_outcome_unresolved as a raw reason', () => {
        const presentation = resolveWorkflowProblemPresentation(actionError('workflow_outcome_unresolved'));

        expect(presentation.message).toBe('workflows.problem.unresolvedOutcome');
        expect(presentation.repair).toBe('refresh');
        // It is a wait, not a rejection of what the person just did.
        expect(presentation.accessibilitySemantics).toBe('status');
    });

    it('offers the repair that can actually make progress', () => {
        expect(resolveWorkflowProblemPresentation(actionError('not_authenticated')))
            .toMatchObject({ code: 'not_authenticated', repair: 'none', repairLabel: null });
        expect(resolveWorkflowProblemPresentation(actionError('currentness_conflict')))
            .toMatchObject({ repair: 'refresh', repairLabel: 'common.refresh' });
        expect(resolveWorkflowProblemPresentation(actionError('target_unavailable')))
            .toMatchObject({ repair: 'retry', repairLabel: 'workflows.retry' });
        // Nothing the person can press changes an access decision.
        expect(resolveWorkflowProblemPresentation(actionError('run_access_denied')))
            .toMatchObject({ repair: 'none', repairLabel: null });
    });

    it('keeps an unrecognized transport failure generic instead of inventing a workflow code', () => {
        const unknown = resolveWorkflowProblemPresentation(actionError('gateway_timeout'));

        expect(unknown.code).toBeNull();
        expect(unknown.message).toBe('workflows.problem.generic');
        expect(unknown.repair).toBe('retry');
        expect(unknown.accessibilitySemantics).toBe('alert');

        expect(resolveWorkflowProblemPresentation(new Error('boom')))
            .toMatchObject({ code: null, message: 'workflows.problem.generic' });
        expect(resolveWorkflowProblemPresentation(undefined))
            .toMatchObject({ code: null, message: 'workflows.problem.generic' });
    });

    it('explains a disabled control from the canonical availability reason, never its code', () => {
        const availability = {
            pause: false,
            resumeBoundary: false,



            restoreWorkspace: false,
            cancel: false,
            inspectExecution: false,
            disabledReasons: [
                { operation: 'cancel' as const, code: 'run_terminal' },
                { operation: 'resume_boundary' as const, code: 'checkpoint_unavailable' },
                { operation: 'retry' as const, code: 'a_code_this_client_does_not_know' },
            ],
        };

        expect(resolveWorkflowOperationUnavailableReason(availability, 'cancel'))
            .toBe('workflows.problem.runFinished');
        expect(resolveWorkflowOperationUnavailableReason(availability, 'resume_boundary'))
            .toBe('workflows.problem.checkpointUnavailable');
        // An unknown reason is still a reason: it says the control is not
        // available without leaking a server identifier.
        expect(resolveWorkflowOperationUnavailableReason(availability, 'retry'))
            .toBe('workflows.problem.unavailableHere');
        // An operation the owner recorded no reason for shows none, rather than
        // a manufactured explanation.
        expect(resolveWorkflowOperationUnavailableReason(availability, 'pause')).toBeNull();
    });

    it('describes the unavailable feature as unavailable, not as a failed load', () => {
        const presentation = resolveWorkflowsUnavailablePresentation();

        expect(presentation).toMatchObject({
            code: null,
            title: 'workflows.unavailable.title',
            message: 'workflows.unavailable.body',
            repair: 'none',
            accessibilitySemantics: 'status',
        });
    });
});
