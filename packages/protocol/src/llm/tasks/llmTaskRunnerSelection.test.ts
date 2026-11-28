import { describe, expect, it } from 'vitest';

import { resolveLlmTaskRunnerV1, type LlmTaskRunnerCandidateV1 } from './llmTaskRunnerSelection.js';

const CLAUDE = 'agent:happier.agent.claude/claude';
const CODEX = 'agent:happier.agent.codex/codex';
const GEMINI = 'agent:happier.agent.gemini/gemini';

function candidate(agentTargetKey: string, modelId: string, extra: Partial<LlmTaskRunnerCandidateV1> = {}): LlmTaskRunnerCandidateV1 {
    return { modelSelection: { agentTargetKey, providerConnectionId: null, modelId }, title: modelId, structuredOutput: 'supported', noTools: true, ...extra };
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const machine: readonly LlmTaskRunnerCandidateV1[] = [
    candidate(CLAUDE, 'claude-opus-5-5', { costTier: 'premium', effortValues: EFFORTS }),
    candidate(CLAUDE, 'claude-sonnet-5-5', { costTier: 'standard' }),
    candidate(CODEX, 'gpt-6.1-sol', { costTier: 'standard', effortValues: EFFORTS }),
    candidate(CODEX, 'gpt-6-luna', { costTier: 'low', effortValues: ['low', 'medium', 'high'] }),
];

describe('background task runner selection', () => {
    it('keeps the explicit choice unchanged even when Auto would pick another Agent; permission stays within the task', () => {
        const choice = { v: 1 as const, modelSelection: { agentTargetKey: CLAUDE, providerConnectionId: 'conn-1', modelId: 'claude-opus-5-5' },
            connectedServices: null, permissionMode: 'full' as const };
        expect(resolveLlmTaskRunnerV1({ task: 'scm_commit_message', choice, candidates: machine, sessionAgentTargetKey: CODEX })).toEqual({
            ok: true, source: 'explicit', runner: { ...choice, permissionMode: 'no_tools' } });
    });

    it('picks the cheapest ready model across Agents, even when the Session uses another Agent', () => {
        expect(resolveLlmTaskRunnerV1({ task: 'memory_hints', choice: null, candidates: machine, sessionAgentTargetKey: CLAUDE }))
            .toMatchObject({ ok: true, source: 'auto', runner: { modelSelection: { agentTargetKey: CODEX, modelId: 'gpt-6-luna' } } });
    });

    it('breaks a cost tie in favour of the Session agent, otherwise catalog order', () => {
        const tied = [...machine, candidate(CLAUDE, 'claude-haiku-5-5', { costTier: 'low' })];
        expect(resolveLlmTaskRunnerV1({ task: 'session_replay_summary', choice: null, candidates: tied, sessionAgentTargetKey: CLAUDE }))
            .toMatchObject({ ok: true, runner: { modelSelection: { agentTargetKey: CLAUDE, modelId: 'claude-haiku-5-5' } } });
        expect(resolveLlmTaskRunnerV1({ task: 'session_replay_summary', choice: null, candidates: tied }))
            .toMatchObject({ ok: true, runner: { modelSelection: { agentTargetKey: CODEX, modelId: 'gpt-6-luna' } } });
    });

    it('asks for the picked model\'s lowest declared effort unless the person set one for the task', () => {
        expect(resolveLlmTaskRunnerV1({ task: 'memory_hints', choice: null, candidates: machine }))
            .toMatchObject({ ok: true, runner: { sessionConfigOptionOverrides: { overrides: { reasoning_effort: { value: 'low' } } } } });
        const chosen = { v: 1 as const, updatedAt: 5, overrides: { reasoning_effort: { value: 'high', updatedAt: 5 } } };
        expect(resolveLlmTaskRunnerV1({ task: 'memory_hints', choice: { v: 1, mode: 'auto', sessionConfigOptionOverrides: chosen }, candidates: machine }))
            .toMatchObject({ ok: true, runner: { sessionConfigOptionOverrides: chosen } });
        const noEffort = resolveLlmTaskRunnerV1({ task: 'memory_hints', choice: null, candidates: [candidate(CLAUDE, 'claude-sonnet-5-5', { costTier: 'standard' })] });
        expect(noEffort.ok && noEffort.runner).not.toHaveProperty('sessionConfigOptionOverrides');
    });

    it('requires structured output and the low tier where the task declares them', () => {
        expect(resolveLlmTaskRunnerV1({ task: 'memory_hints', choice: null,
            candidates: [candidate(CODEX, 'gpt-6-luna', { costTier: 'low', structuredOutput: 'unknown' }), candidate(CLAUDE, 'claude-sonnet-5-5', { costTier: 'standard' })] }))
            .toMatchObject({ ok: true, runner: { modelSelection: { modelId: 'claude-sonnet-5-5' } } });
        expect(resolveLlmTaskRunnerV1({ task: 'scm_diff_summary', choice: null, candidates: [candidate(CLAUDE, 'claude-sonnet-5-5', { costTier: 'standard' })] }))
            .toEqual({ ok: false, errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE', reason: 'no_matching_model', unavailableAgents: [] });
    });

    it('never treats an untagged model as cheap; with no tagged model it uses one Agent\'s catalog default', () => {
        expect(resolveLlmTaskRunnerV1({ task: 'session_replay_summary', choice: null, candidates: [candidate(GEMINI, 'gemini-flash'), ...machine] }))
            .toMatchObject({ ok: true, runner: { modelSelection: { modelId: 'gpt-6-luna' } } });
        expect(resolveLlmTaskRunnerV1({ task: 'session_replay_summary', choice: null, sessionAgentTargetKey: GEMINI,
            candidates: [candidate(CLAUDE, 'claude-x'), candidate(GEMINI, 'gemini-pro'), candidate(GEMINI, 'default')] }))
            .toMatchObject({ ok: true, runner: { modelSelection: { agentTargetKey: GEMINI, modelId: 'default' } } });
    });

    it('never picks a disabled or signed-out Agent and fails typed when nothing is ready', () => {
        const unavailableAgents = [{ agentTargetKey: CODEX, reason: 'sign_in_required' as const }, { agentTargetKey: CLAUDE, reason: 'not_enabled' as const }];
        expect(resolveLlmTaskRunnerV1({ task: 'session_replay_summary', choice: null, candidates: machine, unavailableAgents }))
            .toEqual({ ok: false, errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE', reason: 'no_ready_agent', unavailableAgents });
        expect(resolveLlmTaskRunnerV1({ task: 'session_replay_summary', choice: null, candidates: machine, unavailableAgents: unavailableAgents.slice(0, 1) }))
            .toMatchObject({ ok: true, runner: { modelSelection: { agentTargetKey: CLAUDE, modelId: 'claude-sonnet-5-5' } } });
    });

    it('carries the candidate connected-service route and the chosen permission level on an Auto pick', () => {
        const connectedServices = { v: 2 as const, bindingsByServiceId: {} };
        expect(resolveLlmTaskRunnerV1({ task: 'session_replay_summary', choice: { v: 1, mode: 'auto', permissionMode: 'read_only' },
            candidates: [candidate(CODEX, 'gpt-6-luna', { costTier: 'low', connectedServices })] }))
            .toMatchObject({ ok: true, title: 'gpt-6-luna', runner: { connectedServices, permissionMode: 'read_only' } });
    });
});
