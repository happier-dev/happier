import { describe, expect, it, vi } from 'vitest';

import { runLlmTaskTextPrompt } from '@/agent/executionRuns/tasks/textPromptWithRunnerConfig';
import { LlmTaskRunnerUnavailableError, type LlmTaskRunnerMachineCandidates } from '@/agent/executionRuns/tasks/llmTaskRunner';

const CLAUDE = 'agent:happier.agent.claude/claude';
const CODEX = 'agent:happier.agent.codex/codex';

function startSucceeds() {
  return vi.fn(async (_input: unknown, _context: unknown) => ({
    ok: true as const,
    result: { runId: 'run_1', wait: { ok: true, status: 'succeeded', result: { latestToolResult: '{"ok":true}' } } },
  }));
}

/** Real task-runner owner beneath; only the machine readiness probes and the Run start are boundaries. */
function ownerRunner(executeStart: ReturnType<typeof startSucceeds>, machine: LlmTaskRunnerMachineCandidates) {
  return ((request: Parameters<typeof runLlmTaskTextPrompt>[0]) => runLlmTaskTextPrompt({
    ...request, executeStart, readCandidates: async () => machine,
  })) as typeof runLlmTaskTextPrompt;
}

describe('runMemoryHintsExecutionRun', () => {
  const machine: LlmTaskRunnerMachineCandidates = { unavailableAgents: [], candidates: [
    { modelSelection: { agentTargetKey: CLAUDE, providerConnectionId: null, modelId: 'claude-opus-5-5' }, title: 'Opus', structuredOutput: 'supported', noTools: true },
    { modelSelection: { agentTargetKey: CLAUDE, providerConnectionId: null, modelId: 'claude-haiku-5-5' }, title: 'Haiku', costTier: 'low', structuredOutput: 'supported', noTools: true },
    { modelSelection: { agentTargetKey: CODEX, providerConnectionId: null, modelId: 'gpt-6-luna' }, title: 'Luna', costTier: 'low', structuredOutput: 'supported', noTools: true },
  ] };

  it('passes the hinted Session\'s Agent so it wins a cheapest-tier tie, detached from the Session', async () => {
    const { runMemoryHintsExecutionRun } = await import('./runMemoryHintsExecutionRun');
    const executeStart = startSucceeds();
    const raw = await runMemoryHintsExecutionRun({
      sessionId: 'sess-123', prompt: 'Return JSON', choice: { v: 1, mode: 'auto', permissionMode: 'read_only' }, sessionAgentTargetKey: CODEX,
      runTextPrompt: ownerRunner(executeStart, machine),
    });
    expect(raw).toContain('{"ok":true}');
    expect(executeStart).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: null, intent: 'memory_hints', permissionMode: 'read_only',
      modelSelection: { agentTargetKey: CODEX, providerConnectionId: null, modelId: 'gpt-6-luna' },
    }), expect.not.objectContaining({ defaultSessionId: expect.anything() }));
  });

  it('without a Session Agent takes the cheapest ready model in catalog order', async () => {
    const { runMemoryHintsExecutionRun } = await import('./runMemoryHintsExecutionRun');
    const executeStart = startSucceeds();
    await runMemoryHintsExecutionRun({ sessionId: 's', prompt: 'p', choice: { v: 1, mode: 'auto' }, sessionAgentTargetKey: null,
      runTextPrompt: ownerRunner(executeStart, machine) });
    expect(executeStart).toHaveBeenCalledWith(expect.objectContaining({
      modelSelection: { agentTargetKey: CLAUDE, providerConnectionId: null, modelId: 'claude-haiku-5-5' } }), expect.anything());
  });

  it('runs the person\'s explicit no-tools choice when the Machine supports it', async () => {
    const { runMemoryHintsExecutionRun } = await import('./runMemoryHintsExecutionRun');
    const executeStart = startSucceeds();
    const choice = { v: 1 as const, modelSelection: { agentTargetKey: CLAUDE, providerConnectionId: null, modelId: 'claude-haiku-5-5' }, permissionMode: 'no_tools' as const };
    await runMemoryHintsExecutionRun({ sessionId: 's', prompt: 'p', choice, sessionAgentTargetKey: CODEX,
      runTextPrompt: ownerRunner(executeStart, machine) });
    expect(executeStart).toHaveBeenCalledWith(expect.objectContaining({ modelSelection: choice.modelSelection, permissionMode: 'no_tools' }), expect.anything());
  });

  it('fails with the typed reason and starts no Run when nothing is ready', async () => {
    const { runMemoryHintsExecutionRun } = await import('./runMemoryHintsExecutionRun');
    const executeStart = startSucceeds();
    await expect(runMemoryHintsExecutionRun({ sessionId: 's', prompt: 'p', choice: { v: 1, mode: 'auto' }, sessionAgentTargetKey: CLAUDE,
      runTextPrompt: ownerRunner(executeStart, { candidates: [], unavailableAgents: [{ agentTargetKey: CLAUDE, reason: 'sign_in_required' }] }) }))
      .rejects.toBeInstanceOf(LlmTaskRunnerUnavailableError);
    expect(executeStart).not.toHaveBeenCalled();
  });
});
