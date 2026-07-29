import { describe, expect, it, vi } from 'vitest';

import {
    createClaudePermissionEngine,
    type ClaudePermissionContext,
} from './createClaudePermissionEngine.js';

function createContextWithRequestDecision(
    requestDecision: ReturnType<typeof vi.fn>,
): ClaudePermissionContext {
    return {
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

    it('carries structured AskUserQuestion answers into Claude updated input', async () => {
        const requestDecision = vi.fn(async () => ({
            decision: 'approved' as const,
            answers: { 'Continue with cleanup?': 'Keep the files' },
        }));
        const ctx = createContextWithRequestDecision(requestDecision);
        const engine = createClaudePermissionEngine(ctx);

        const result = await engine.canCallTool('AskUserQuestion', {
            questions: [{ question: 'Continue with cleanup?' }],
        }, {
            toolUseId: 'toolu_ask_1',
        });

        expect(result).toEqual({
            behavior: 'allow',
            updatedInput: {
                questions: [{ question: 'Continue with cleanup?' }],
                answers: { 'Continue with cleanup?': 'Keep the files' },
            },
        });
    });

    it('carries structured ask_user_question answers into Claude updated input', async () => {
        const requestDecision = vi.fn(async () => ({
            decision: 'approved' as const,
            answers: { 'Remove scratch files?': 'Keep them' },
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
