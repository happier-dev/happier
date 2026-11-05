import { describe, expect, it, vi } from 'vitest';

import { WORKFLOW_OPERATION_ERROR_CODES_V1 } from '@happier-dev/protocol';
import { normalizeWorkflowActionThrownError } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { WorkflowActionFailureV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { actionStartTargetUnavailableV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';

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
    it('keeps the existing target failure and retry for content-free host admission diagnostics', () => {
        const failure = WorkflowActionFailureV1Schema.parse(actionStartTargetUnavailableV1(undefined,
            'agent_start_context', 'caller_agent_unavailable'));
        const typed = new WorkflowActionError({ rawCode: failure.errorCode, message: failure.error, failure });
        expect(resolveWorkflowProblemPresentation(typed)).toMatchObject({
            ...resolveWorkflowProblemPresentation(actionError('target_unavailable')),
            technicalDetails: [
                { key: 'code', label: expect.any(String), value: 'target_unavailable' },
                { key: 'reason', label: expect.any(String), value: 'caller_agent_unavailable' },
            ],
        });
    });
    it('explains Account-wide role preparation and offers retry from the real strict failure projection', () => {
        const failure = WorkflowActionFailureV1Schema.parse(normalizeWorkflowActionThrownError(
            Object.assign(new Error('private catalog contents'), { code: 'account_role_overrides_unavailable' }),
        ));
        const error = new WorkflowActionError({ rawCode: failure.errorCode, message: failure.error, failure });
        expect(resolveWorkflowProblemPresentation(error)).toMatchObject({
            code: 'content_unavailable', title: 'workflows.problem.accountRolesUnavailableTitle',
            message: 'workflows.problem.accountRolesUnavailable', repair: 'retry', repairLabel: 'workflows.retry',
            accessibilitySemantics: 'alert',
        });
        expect(resolveWorkflowProblemPresentation(actionError('role_target_unavailable'))).toMatchObject({
            message: 'workflows.problem.roleTargetUnavailable', repair: 'none',
        });
    });

    it('titles a missing Run for what it is rather than with the generic failure heading', () => {
        expect(resolveWorkflowProblemPresentation(actionError('run_not_found'))).toMatchObject({
            title: 'workflows.problem.notFoundTitle', message: 'workflows.problem.notFound',
        });
    });

    it('presents the precise conversation check from the typed refusal', () => {
        const error = new WorkflowActionError({ rawCode: 'workflow_conversation_unavailable', message: 'private diagnostics',
            failure: { ok: false, errorCode: 'workflow_conversation_unavailable', error: 'workflow_conversation_unavailable',
                details: { code: 'workflow_conversation_unavailable', reason: 'agentTarget', expected: { kind: 'agent' }, observed: { kind: 'unset' } } } });
        expect(resolveWorkflowProblemPresentation(error)).toMatchObject({ message: 'workflows.problem.conversationChecks.agentTarget', repair: 'none' });
    });
    it('presents the exact-machine Agent probe repair rather than an opaque target refusal', () => {
        const error = new WorkflowActionError({ rawCode: 'target_unavailable', message: 'private diagnostics',
            failure: { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
                details: { code: 'target_unavailable', reason: 'agent_probe_failed', agentId: 'claude', errorCode: 'cli-detection-failed' } } });
        expect(resolveWorkflowProblemPresentation(error)).toMatchObject({
            code: 'target_unavailable', message: 'machineAgents.unknown', repair: 'retry', accessibilitySemantics: 'alert',
        });
    });
    it('distinguishes unsupported architecture from a failed probe without sending install repairs to Account settings', () => {
        const unsupported = new WorkflowActionError({ rawCode: 'target_unavailable', message: 'private diagnostics',
            failure: { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
                details: { code: 'target_unavailable', reason: 'platform_unsupported', platformReason: 'arch' } } });
        expect(resolveWorkflowProblemPresentation(unsupported)).toMatchObject({ message: 'machineAgents.unsupportedArch', repair: 'none' });
        const missing = new WorkflowActionError({ rawCode: 'target_unavailable', message: 'private diagnostics',
            failure: { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
                details: { code: 'target_unavailable', reason: 'agent_not_installed' } } });
        expect(resolveWorkflowProblemPresentation(missing)).toMatchObject({ message: 'machineAgents.notInstalled', repair: 'none' });
    });
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
    it('names opened built-ins without overriding explicit names or unreadable state', () => {
        const accepted = { source: { kind: 'catalog', ref: 'builtin:fresh-opinions', version: 1 } } as const;
        expect(resolveWorkflowRunDisplayName(null, accepted)).toEqual({ kind: 'name', value: 'Fresh opinions' });
        expect(resolveWorkflowRunDisplayName(null, { ...accepted, metadata: { title: 'Named at acceptance' } }))
            .toEqual({ kind: 'name', value: 'Named at acceptance' });
        expect(resolveWorkflowRunDisplayName({ kind: 'unavailable', reason: 'waiting_for_keys' }, accepted))
            .toEqual({ kind: 'unavailable', reason: 'waiting_for_keys' });
        expect(resolveWorkflowRunDisplayName(null, { source: { kind: 'inline' } })).toEqual({ kind: 'unknown' });
        expect(resolveWorkflowRunDisplayName(null, { source: { kind: 'catalog', ref: 'builtin:unknown', version: 1 } }))
            .toEqual({ kind: 'unknown' });
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

    it('says a Run moved on for a Run control conflict, never the editor\'s kept-local-work reassurance (DESIGN-14 D9)', () => {
        expect(resolveWorkflowProblemPresentation(actionError('currentness_conflict'), 'run'))
            .toMatchObject({ message: 'workflows.problem.runMovedOn', repair: 'refresh', repairLabel: 'common.refresh' });
        expect(resolveWorkflowProblemPresentation(actionError('currentness_conflict')).message).toBe('workflows.problem.conflict');
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
