import { describe, expect, it, vi } from 'vitest';

import {
    createClaudePermissionEngine,
    type ClaudePermissionContext,
} from './createClaudePermissionEngine.js';

function createContextWithRequestDecision(
    requestDecision: ReturnType<typeof vi.fn>,
): ClaudePermissionContext {
    return {
        agentRuntime: { modes: { bind: () => ({ dispose() {} }), complete: async () => {} } },
        sessions: {
            current: {
                permissions: {
                    requestDecision,
                    getMode: () => 'default',
                },
            },
        },
    } as ClaudePermissionContext;
}

function createContextFixture(decision: 'approved' | 'denied' | 'abort') {
    const requestDecision = vi.fn(async () => ({
        decision,
        rationale: decision === 'denied' ? 'Denied by policy' : undefined,
    }));
    const ctx = createContextWithRequestDecision(requestDecision);
    return { ctx, requestDecision };
}

describe('createClaudePermissionEngine', () => {
    it('offers the existing aborting Claude stop outcome', async () => {
        const { ctx, requestDecision } = createContextFixture('approved');
        await createClaudePermissionEngine(ctx).canCallTool('Bash', { command: 'pwd' }, { requestId: 'stop-native' });
        expect(requestDecision.mock.calls[0]?.[0].nativeChoices.choices).toContainEqual(expect.objectContaining({
            id: 'stop', decision: 'abort', response: { approved: false, decision: 'abort', mode: 'read-only' },
        }));
    });
    it('offers the existing plan approval modes and request-changes feedback from the producer', async () => {
        const { ctx, requestDecision } = createContextFixture('approved');
        await createClaudePermissionEngine(ctx).canCallTool('ExitPlanMode', { plan: 'Make the change' }, { requestId: 'plan-modes' });
        expect(requestDecision.mock.calls[0]?.[0].nativeChoices.choices).toEqual(expect.arrayContaining([
            ...(['default', 'acceptEdits', 'bypassPermissions'] as const).map(mode => expect.objectContaining({
                id: `approve:${mode}`, scope: 'session', response: { approved: true, decision: 'approved', mode,
                    updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] },
            })),
            expect.objectContaining({ id: 'deny', decision: 'denied', allowsFeedback: true }),
        ]));
    });
    it.each(['ExitPlanMode', 'exit_plan_mode'])('clears the saved Plan selection when %s is approved', async (toolName) => {
        const { ctx } = createContextFixture('approved');
        let selectedMode: string | null = 'plan';
        const engine = createClaudePermissionEngine({ ...ctx, agentRuntime: { modes: {
            bind: () => ({ dispose() {} }),
            complete: async ({ modeId }) => { if (selectedMode === modeId) selectedMode = null; },
        } } });
        expect((await engine.canCallTool(toolName, { plan: 'Review the change' })).behavior).toBe('allow');
        expect(selectedMode).toBeNull();
    });

    it('maps Claude tool checks to the host session permission surface', async () => {
        const { ctx, requestDecision } = createContextFixture('approved');
        const engine = createClaudePermissionEngine(ctx);

        const result = await engine.canCallTool('Edit', { file_path: 'README.md' }, {
            signal: new AbortController().signal,
            toolUseId: 'toolu_1',
        });

        expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'claude',
            requestId: 'toolu_1',
            toolCallId: 'toolu_1',
            toolName: 'Edit',
            input: { file_path: 'README.md' },
        }), expect.objectContaining({
            signal: expect.any(AbortSignal),
        }));
        expect(result).toEqual({
            behavior: 'allow',
            updatedInput: { file_path: 'README.md' },
        });
    });

    it('offers canonical edit grants and stop outcomes at the producer', async () => {
        const { ctx, requestDecision } = createContextFixture('approved');
        await createClaudePermissionEngine(ctx).canCallTool('Edit', { file_path: 'README.md' }, { requestId: 'edit-ask' });
        const request = requestDecision.mock.calls[0]?.[0];
        expect(request.nativeChoices).toMatchObject({
            requirementId: 'edit-ask', source: 'claude',
            choices: expect.arrayContaining([
                expect.objectContaining({ id: 'allow_all_edits', decision: 'approved', scope: 'session', response: {
                    approved: true, decision: 'approved', mode: 'acceptEdits',
                    updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
                } }),
                expect.objectContaining({ id: 'stop', decision: 'abort', scope: 'session', response: { approved: false, decision: 'abort', mode: 'read-only' } }),
            ]),
        });
    });

    it('projects single- and multi-select AskUserQuestion arrays into Claude answer strings', async () => {
        const requestDecision = vi.fn(async () => ({
            decision: 'approved' as const,
            answers: {
                'Continue with cleanup?': ['Keep the files'],
                checks: ['types', 'unit'],
            },
        }));
        const ctx = createContextWithRequestDecision(requestDecision);
        const engine = createClaudePermissionEngine(ctx);

        const questions = [
            { question: 'Continue with cleanup?' },
            { id: 'checks', question: 'Which checks?', multiSelect: true, options: [
                { id: 'unit', label: 'Unit tests, then integration' }, { id: 'types', label: 'Say \"typecheck\"' },
            ] },
        ];
        const result = await engine.canCallTool('AskUserQuestion', {
            questions,
        }, {
            toolUseId: 'toolu_ask_1',
        });

        expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
            input: {
                questions: questions.map(question => ({ ...question, freeform: {} })),
            },
        }), expect.any(Object));

        expect(result).toEqual({
            behavior: 'allow',
            updatedInput: {
                questions,
                answers: {
                    'Continue with cleanup?': 'Keep the files',
                    'Which checks?': 'Unit tests, then integration, Say \"typecheck\"',
                },
            },
        });
    });

    it('carries structured ask_user_question answers into Claude updated input', async () => {
        const requestDecision = vi.fn(async () => ({
            decision: 'approved' as const,
            answers: { 'Remove scratch files?': ['Keep them'] },
        }));
        const ctx = createContextWithRequestDecision(requestDecision);
        const engine = createClaudePermissionEngine(ctx);

        const result = await engine.canCallTool('ask_user_question', {
            questions: [{ question: 'Remove scratch files?' }],
        }, {
            toolUseId: 'toolu_ask_2',
        });

        expect(result).toEqual({
            behavior: 'allow',
            updatedInput: {
                questions: [{ question: 'Remove scratch files?' }],
                answers: { 'Remove scratch files?': 'Keep them' },
            },
        });
    });

    it('uses host-updated tool input when the permission surface supplies it', async () => {
        const requestDecision = vi.fn(async () => ({
            decision: 'approved' as const,
            updatedInput: { command: 'echo safe' },
        }));
        const ctx = createContextWithRequestDecision(requestDecision);
        const engine = createClaudePermissionEngine(ctx);

        const result = await engine.canCallTool('Bash', { command: 'echo unsafe' }, {
            toolUseId: 'toolu_bash_1',
        });

        expect(result).toEqual({
            behavior: 'allow',
            updatedInput: { command: 'echo safe' },
        });
    });

    it('maps host denial to Claude interrupting permission denial', async () => {
        const { ctx } = createContextFixture('denied');
        const engine = createClaudePermissionEngine(ctx);

        await expect(engine.canCallTool('Write', { file_path: 'README.md' }, {
            signal: new AbortController().signal,
        })).resolves.toEqual({
            behavior: 'deny',
            message: 'Denied by policy',
            interrupt: true,
        });
    });

    it('preserves host-supplied updatedPermissions through the allow result', async () => {
        const requestDecision = vi.fn(async () => ({
            decision: 'approved' as const,
            updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }],
        }));
        const ctx = createContextWithRequestDecision(requestDecision);
        const engine = createClaudePermissionEngine(ctx);

        const result = await engine.canCallTool('Bash', { command: 'ls' }, { toolUseId: 'toolu_rule_1' });

        expect(result).toEqual({
            behavior: 'allow',
            updatedInput: { command: 'ls' },
            updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }],
        });
    });

    it('synthesizes a setMode default updatedPermissions when ExitPlanMode is approved', async () => {
        const { ctx } = createContextFixture('approved');
        const engine = createClaudePermissionEngine(ctx);

        const result = await engine.canCallTool('ExitPlanMode', { plan: 'do the thing' }, {
            toolUseId: 'toolu_exit_plan_1',
        });

        expect(result).toEqual({
            behavior: 'allow',
            updatedInput: { plan: 'do the thing' },
            updatedPermissions: [{ type: 'setMode', mode: 'default' }],
        });
    });

    it('respects host-supplied updatedPermissions on ExitPlanMode instead of synthesizing', async () => {
        const requestDecision = vi.fn(async () => ({
            decision: 'approved' as const,
            updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits' }],
        }));
        const ctx = createContextWithRequestDecision(requestDecision);
        const engine = createClaudePermissionEngine(ctx);

        const result = await engine.canCallTool('exit_plan_mode', { plan: 'x' }, {
            toolUseId: 'toolu_exit_plan_2',
        });

        expect(result).toEqual({
            behavior: 'allow',
            updatedInput: { plan: 'x' },
            updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits' }],
        });
    });
});
