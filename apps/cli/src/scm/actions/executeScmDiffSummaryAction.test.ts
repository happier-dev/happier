import { describe, expect, it, vi } from 'vitest';

import { executeScmDiffSummaryAction } from './executeScmDiffSummaryAction';

const BACKEND_TARGET = {
    kind: 'backend' as const,
    backendId: 'codex',
    sourceKind: 'built_in' as const,
};

describe('executeScmDiffSummaryAction', () => {
    it('uses canonical start-and-wait then get without selecting a second run scope', async () => {
        const output = {
            success: true as const,
            summaryMarkdown: '## Summary\n\nChanged one file.',
            sourceKey: 'workingTree:/workspace',
            metadata: {
                source: { kind: 'workingTree' as const },
                sourceKey: 'workingTree:/workspace',
            },
        };
        const executeCanonicalAction = vi.fn(async (actionId: string, _input: unknown) => {
            if (actionId === 'execution.run.start') {
                return {
                    ok: true as const,
                    result: {
                        runId: 'run-1',
                        callId: 'call-1',
                        sidechainId: 'sidechain-1',
                        wait: {
                            ok: true as const,
                            status: 'succeeded' as const,
                            result: { run: { runId: 'run-1', status: 'succeeded' as const } },
                        },
                    },
                };
            }
            if (actionId === 'execution.run.get') {
                return {
                    ok: true as const,
                    result: {
                        run: { runId: 'run-1', status: 'succeeded' as const },
                        latestToolResult: output,
                    },
                };
            }
            throw new Error(`unexpected action: ${actionId}`);
        });

        await expect(executeScmDiffSummaryAction({
            request: { cwd: '/workspace', source: { kind: 'workingTree' } },
            backendTarget: BACKEND_TARGET,
            executeCanonicalAction,
        })).resolves.toEqual(output);
        expect(executeCanonicalAction).toHaveBeenNthCalledWith(1, 'execution.run.start', expect.objectContaining({
            kind: 'scm_diff_summary.v1',
            intent: 'scm_diff_summary',
            backendTarget: BACKEND_TARGET,
            permissionMode: 'read_only',
            waitForCompletion: true,
            intentInput: { cwd: '/workspace', source: { kind: 'workingTree' } },
        }));
        expect(executeCanonicalAction.mock.calls[0]?.[1]).not.toHaveProperty('sessionId');
        expect(executeCanonicalAction).toHaveBeenNthCalledWith(2, 'execution.run.get', {
            runId: 'run-1',
            includeStructured: true,
        });
    });

    it('fails checkpoint direction explicitly instead of trusting caller-injected TurnChangeSet evidence', async () => {
        const executeCanonicalAction = vi.fn();
        await expect(executeScmDiffSummaryAction({
            request: {
                cwd: '/workspace',
                source: { kind: 'turnCheckpoint' },
                turnId: 'turn-1',
                checkpointReceiptId: 'checkpoint.diff_computed',
                turnChangeSet: { forged: true },
            },
            backendTarget: BACKEND_TARGET,
            executeCanonicalAction,
        })).resolves.toMatchObject({
            success: false,
            errorCode: 'TURN_CHANGE_SET_REQUIRED',
            sourceKey: 'turnCheckpoint:turn-1:checkpoint.diff_computed',
        });
        expect(executeCanonicalAction).not.toHaveBeenCalled();
    });

    it('preserves a cancelled observation as a failed summary without stopping the started run', async () => {
        const executeCanonicalAction = vi.fn(async () => ({
            ok: true as const,
            result: {
                runId: 'run-cancel',
                callId: 'call-1',
                sidechainId: 'sidechain-1',
                wait: { ok: false as const, code: 'cancelled' as const },
            },
        }));

        await expect(executeScmDiffSummaryAction({
            request: { cwd: '/workspace', source: { kind: 'workingTree' } },
            backendTarget: BACKEND_TARGET,
            executeCanonicalAction,
        })).resolves.toMatchObject({
            success: false,
            errorCode: 'SUMMARY_FAILED',
            error: 'Diff-summary execution run observation was cancelled',
        });
        expect(executeCanonicalAction).toHaveBeenCalledTimes(1);
        expect(executeCanonicalAction).toHaveBeenCalledWith('execution.run.start', expect.objectContaining({
            waitForCompletion: true,
        }));
    });

    it('preserves an unknown start outcome without relabeling it as model unavailability or retrying', async () => {
        const executeCanonicalAction = vi.fn(async () => ({
            ok: false as const,
            errorCode: 'execution_run_target_unavailable',
            error: 'execution_run_target_unavailable',
            details: { executionRunStart: { v: 1 as const, runCreation: 'outcomeUnknown' as const } },
        }));

        await expect(executeScmDiffSummaryAction({
            request: { cwd: '/workspace', source: { kind: 'workingTree' } },
            backendTarget: BACKEND_TARGET,
            executeCanonicalAction,
        })).resolves.toMatchObject({
            success: false,
            errorCode: 'SUMMARY_FAILED',
            error: 'Diff-summary execution run start outcome is unknown',
        });
        expect(executeCanonicalAction).toHaveBeenCalledTimes(1);
        expect(executeCanonicalAction).toHaveBeenCalledWith('execution.run.start', expect.any(Object));
    });

    it('does not treat an observation deadline as a run stop or a completed result', async () => {
        const executeCanonicalAction = vi.fn(async () => ({
            ok: true as const,
            result: {
                runId: 'run-observation',
                callId: 'call-1',
                sidechainId: 'sidechain-1',
                wait: { ok: false as const, code: 'timeout' as const },
            },
        }));

        await expect(executeScmDiffSummaryAction({
            request: { cwd: '/workspace', source: { kind: 'workingTree' } },
            backendTarget: BACKEND_TARGET,
            executeCanonicalAction,
        })).resolves.toMatchObject({
            success: false,
            errorCode: 'SUMMARY_FAILED',
            error: 'Diff-summary execution run observation deadline elapsed before terminal output',
        });
        expect(executeCanonicalAction).toHaveBeenCalledTimes(1);
    });
});
