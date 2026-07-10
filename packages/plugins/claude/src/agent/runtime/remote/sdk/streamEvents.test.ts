import { describe, expect, it } from 'vitest';

import {
    hasClaudeAgentSdkRuntimeAuthFailureEvidence,
    isClaudeAgentSdkStopHookWithNoBackgroundTasks,
    readClaudeAgentSdkBackgroundTaskId,
    readClaudeAgentSdkResultFailure,
    readClaudeAgentSdkResultText,
} from './index.js';

describe('Claude remote SDK stream event helpers', () => {
    it('normalizes result text and redacted failure detail', () => {
        expect(readClaudeAgentSdkResultText({
            type: 'result',
            result: '  complete  ',
        })).toBe('complete');

        expect(readClaudeAgentSdkResultFailure({
            type: 'result',
            subtype: 'error_during_execution',
            errors: [
                'first failure',
                { message: 'second failure', token: 'sk-ant-secret-value' },
            ],
            result: 'final failure',
        })).toMatch(/^error_during_execution: /);
        expect(readClaudeAgentSdkResultFailure({
            type: 'result',
            subtype: 'success',
            errors: ['ignored'],
        })).toBeNull();
    });

    it('reads background task and stop-hook state from Claude SDK messages', () => {
        expect(readClaudeAgentSdkBackgroundTaskId({
            type: 'user',
            tool_use_result: {
                assistantAutoBackgrounded: true,
                background_task_id: ' task-1 ',
            },
        })).toBe('task-1');

        expect(readClaudeAgentSdkBackgroundTaskId({
            type: 'user',
            toolUseResult: {
                status: 'async_launched',
                taskId: 'task-2',
            },
        })).toBe('task-2');

        expect(readClaudeAgentSdkBackgroundTaskId({
            type: 'user',
            tool_use_result: {
                status: 'async_launched',
                agentId: ' agent-3 ',
            },
        })).toBe('agent-3');

        expect(readClaudeAgentSdkBackgroundTaskId({
            type: 'user',
            tool_use_result: {
                assistantAutoBackgrounded: false,
                background_task_id: 'task-1',
            },
        })).toBeNull();

        expect(isClaudeAgentSdkStopHookWithNoBackgroundTasks({
            hook_event_name: 'Stop',
            background_tasks: [],
        })).toBe(true);
        expect(isClaudeAgentSdkStopHookWithNoBackgroundTasks({
            hook_event_name: 'Stop',
            background_tasks: ['task-1'],
        })).toBe(false);
    });

    it('never treats sidechain/subagent-scoped auth failures as parent runtime-auth evidence', () => {
        // Incident 2026-06-12 (cmq8y3nlx): a background subagent hit a transient 401 and its
        // transcript message was classified as parent auth evidence, SIGTERMing the healthy
        // parent runner. Subagent-scoped failures are never parent auth evidence.
        const incidentMessage = {
            type: 'assistant',
            isApiErrorMessage: true,
            apiErrorStatus: 401,
            error: 'authentication_failed',
            message: {
                content: [{ type: 'text', text: 'Please run /login · API Error: 401 Invalid authentication credentials' }],
            },
        };

        expect(hasClaudeAgentSdkRuntimeAuthFailureEvidence({
            ...incidentMessage,
            isSidechain: true,
        })).toBe(false);
        expect(hasClaudeAgentSdkRuntimeAuthFailureEvidence({
            ...incidentMessage,
            parent_tool_use_id: 'toolu_abc123',
        })).toBe(false);
        expect(hasClaudeAgentSdkRuntimeAuthFailureEvidence({
            ...incidentMessage,
            parentToolUseId: 'toolu_abc123',
        })).toBe(false);

        // The same evidence scoped to the parent session still routes to auth recovery.
        expect(hasClaudeAgentSdkRuntimeAuthFailureEvidence(incidentMessage)).toBe(true);
        expect(hasClaudeAgentSdkRuntimeAuthFailureEvidence({
            ...incidentMessage,
            isSidechain: false,
            parent_tool_use_id: null,
        })).toBe(true);
    });

    it('keeps provider-owned Claude SDK 401 retries out of runtime auth evidence', () => {
        expect(hasClaudeAgentSdkRuntimeAuthFailureEvidence({
            type: 'system',
            subtype: 'api_error',
            attempt: 1,
            max_retries: 11,
            retry_delay_ms: 1_000,
            error_status: 401,
            error: 'Connection error.',
        })).toBe(false);

        expect(hasClaudeAgentSdkRuntimeAuthFailureEvidence({
            type: 'system',
            subtype: 'api_error',
            attempt: 11,
            max_retries: 11,
            retry_delay_ms: 1_000,
            error_status: 401,
            error: 'Connection error.',
        })).toBe(true);

        expect(hasClaudeAgentSdkRuntimeAuthFailureEvidence({
            type: 'result',
            subtype: 'error_during_execution',
            error: {
                type: 'authentication_error',
                message: 'invalid oauth token',
            },
        })).toBe(true);

        expect(hasClaudeAgentSdkRuntimeAuthFailureEvidence({
            type: 'result',
            subtype: 'error_during_execution',
            error: {
                type: 'rate_limit_error',
                message: 'slow down',
            },
        })).toBe(false);
    });
});
