import { describe, expect, it } from 'vitest';

import {
    mapClaudeHookEventToTerminalLifecycleObservation,
    mapClaudeTranscriptEventToTerminalLifecycleObservation,
} from './lifecycle.js';

describe('Claude terminal lifecycle mapping leaf', () => {
    it('ignores hook-originated task-notification prompt submissions', () => {
        expect(mapClaudeHookEventToTerminalLifecycleObservation({
            agentId: 'claude',
            eventName: 'UserPromptSubmit',
            turnId: 'claude-turn',
            promptText: [
                '<task-notification>',
                '<task-id>agent-1</task-id>',
                '<status>completed</status>',
                '</task-notification>',
            ].join('\n'),
        })).toBeNull();
    });

    it('treats Stop hooks as completion candidates only', () => {
        expect(mapClaudeHookEventToTerminalLifecycleObservation({
            agentId: 'claude',
            eventName: 'Stop',
            turnId: 'claude-turn',
        })).toEqual({
            type: 'completion_candidate',
            agentId: 'claude',
            turnId: 'claude-turn',
            source: 'hook',
        });
    });

    it('maps StopFailure hooks to failed terminal boundaries', () => {
        expect(mapClaudeHookEventToTerminalLifecycleObservation({
            agentId: 'claude',
            eventName: 'StopFailure',
            turnId: 'claude-turn',
            detail: 'hook failed',
        })).toEqual({
            type: 'turn_failed',
            agentId: 'claude',
            turnId: 'claude-turn',
            reason: 'stop_failure_hook',
            detail: 'hook failed',
            source: 'hook',
        });
    });

    it('maps compact hooks to compaction lifecycle observations', () => {
        expect(mapClaudeHookEventToTerminalLifecycleObservation({
            agentId: 'claude',
            eventName: 'PreCompact',
        })).toEqual({
            type: 'compaction_started',
            agentId: 'claude',
            source: 'hook',
        });
        expect(mapClaudeHookEventToTerminalLifecycleObservation({
            agentId: 'claude',
            eventName: 'PostCompact',
        })).toEqual({
            type: 'compaction_completed',
            agentId: 'claude',
            source: 'hook',
        });
    });

    it('invalidates Claude completion candidates when stop-hook feedback continues the turn', () => {
        expect(mapClaudeTranscriptEventToTerminalLifecycleObservation({
            agentId: 'claude',
            kind: 'stop_hook_feedback',
            turnId: 'claude-turn',
        })).toEqual({
            type: 'completion_candidate_invalidated',
            agentId: 'claude',
            turnId: 'claude-turn',
            reason: 'stop_hook_feedback',
        });
    });

    it('maps compact boundary transcript rows to compaction completion', () => {
        expect(mapClaudeTranscriptEventToTerminalLifecycleObservation({
            agentId: 'claude',
            kind: 'compact_boundary',
            turnId: 'compact-boundary-1',
        })).toEqual({
            type: 'compaction_completed',
            agentId: 'claude',
            turnId: 'compact-boundary-1',
            source: 'transcript',
        });
    });

    it('maps interrupted transcript rows to user interrupts', () => {
        expect(mapClaudeTranscriptEventToTerminalLifecycleObservation({
            agentId: 'claude',
            kind: 'text',
            text: '[Request interrupted by user]',
            turnId: 'claude-turn',
        })).toEqual({
            type: 'turn_aborted',
            agentId: 'claude',
            turnId: 'claude-turn',
            reason: 'user_interrupt',
            detail: '[Request interrupted by user]',
            source: 'transcript',
        });
    });
});
