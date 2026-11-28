import { describe, expect, it } from 'vitest';
import { isLlmTaskRunnerAutoV1, LlmTaskRunnerChoiceV1Schema, LlmTaskRunnerConfigV1Schema, LlmTaskRunnerConfigV1WriteSchema } from './llmTaskRunnerConfigV1.js';
import { ProviderBoundModelRefSchema } from '../../providers/selection/v1.js';

describe('task runner model selection', () => {
    it('reads predecessor-created configured runner data into the canonical model reference', () => {
        // ../0.2 at 8be20e6c: llmTasks/llmTaskRunnerConfigV1.ts and Replay summary writer.
        const result = LlmTaskRunnerConfigV1Schema.parse({ v: 1,
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot', future: true },
            modelId: '  custom/model  ', permissionMode: 'no_tools', future: true });
        expect(result).toEqual({ v: 1, modelSelection: {
            agentTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot',
            providerConnectionId: null, modelId: 'custom/model',
        }, permissionMode: 'no_tools' });
    });
    it('reads a canonical selection with unknown stored fields without losing its configured definition', () => {
        const modelSelection = ProviderBoundModelRefSchema.parse({
            agentTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:other', providerConnectionId: null, modelId: 'custom/model',
        });
        expect(LlmTaskRunnerConfigV1Schema.parse({ v: 1, modelSelection: { ...modelSelection, future: true }, future: true }))
            .toEqual({ v: 1, modelSelection });
    });
    it('rejects an unroutable predecessor target as invalid stored data without throwing from safeParse', () => {
        expect(LlmTaskRunnerConfigV1Schema.safeParse({ v: 1,
            backendTarget: { kind: 'builtInAgent', agentId: 'invalid:target' }, modelId: 'default',
        }).success).toBe(false);
    });
    it('normalizes the predecessor omitted model to an explicit native default and writes only the current shape', () => {
        const predecessor = { v: 1, backendTarget: { kind: 'builtInAgent', agentId: 'claude' } };
        const runner = LlmTaskRunnerConfigV1Schema.parse(predecessor);
        expect(LlmTaskRunnerConfigV1WriteSchema.parse(runner)).toEqual({ v: 1, modelSelection: {
            agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'default',
        } });
        expect(LlmTaskRunnerConfigV1WriteSchema.safeParse(predecessor).success).toBe(false);
        expect(LlmTaskRunnerConfigV1WriteSchema.safeParse({ ...runner, backendTarget: predecessor.backendTarget }).success).toBe(false);
    });
    it('refuses an invalid current selection without recovering routing or permission authority from predecessor fields', () => {
        const predecessor = { v: 1, backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId: 'default' };
        expect(LlmTaskRunnerConfigV1Schema.safeParse({ ...predecessor, modelSelection: null, permissionMode: 'no_tools' }).success).toBe(false);
        expect(LlmTaskRunnerConfigV1Schema.safeParse({ ...predecessor, permissionMode: 'unknown_mode' }).success).toBe(false);
    });
    it('writes a Provider-connection model with its connected-service route and effort', () => {
        const runner = { v: 1, modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'connection', modelId: 'gpt-6-luna' },
            connectedServices: null, sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { reasoning_effort: { value: 'low', updatedAt: 1 } } },
            permissionMode: 'read_only' };
        expect(LlmTaskRunnerConfigV1WriteSchema.parse(runner)).toEqual(runner);
    });
    it('reads Auto as its own state, distinct from an explicit runner', () => {
        expect(LlmTaskRunnerChoiceV1Schema.parse({ v: 1, mode: 'auto', future: true })).toEqual({ v: 1, mode: 'auto' });
        expect(isLlmTaskRunnerAutoV1(LlmTaskRunnerChoiceV1Schema.parse({ v: 1, backendTarget: { kind: 'builtInAgent', agentId: 'codex' } }))).toBe(false);
    });
});
