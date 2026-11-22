import { expect, it, vi } from 'vitest';

import type { LlmTaskRunnerCandidateV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerSelection';
import { resolveLlmTaskRunnerOnThisMachine } from './llmTaskRunner';

const muse = {
  title: 'Muse', noTools: false,
  modelSelection: { agentTargetKey: 'agent:happier.agent.muse/muse', providerConnectionId: null, modelId: 'meta/muse-spark-1.3-contributor' },
} satisfies LlmTaskRunnerCandidateV1;
const codex = {
  title: 'Codex', noTools: true,
  modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'default' },
} satisfies LlmTaskRunnerCandidateV1;

it('refuses explicit native Muse when the task requires no-tools', async () => {
  const choice = { v: 1 as const, modelSelection: muse.modelSelection, permissionMode: 'read_only' as const };
  const readCandidates = vi.fn(async () => ({ candidates: [muse, codex], unavailableAgents: [] }));
  expect(await resolveLlmTaskRunnerOnThisMachine({ task: 'deploy_suggestion', choice, readCandidates })).toMatchObject({
    ok: false, errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE', reason: 'no_matching_model',
  });
  expect(readCandidates).toHaveBeenCalledTimes(1);
});

it('keeps the explicit enforcing Agent and model for a no-tools task', async () => {
  const choice = { v: 1 as const, modelSelection: codex.modelSelection };
  const readCandidates = async () => ({ candidates: [muse, codex], unavailableAgents: [] });
  expect(await resolveLlmTaskRunnerOnThisMachine({ task: 'deploy_suggestion', choice, readCandidates })).toEqual({
    ok: true, source: 'explicit', runner: { ...choice, permissionMode: 'no_tools' },
  });
});

it('keeps explicit read-only Muse without reading the machine model inventory', async () => {
  const choice = { v: 1 as const, modelSelection: muse.modelSelection, permissionMode: 'read_only' as const };
  const readCandidates = vi.fn(async () => ({ candidates: [muse, codex], unavailableAgents: [] }));
  expect(await resolveLlmTaskRunnerOnThisMachine({ task: 'session_replay_summary', choice, readCandidates })).toEqual({
    ok: true, source: 'explicit', runner: choice,
  });
  expect(readCandidates).not.toHaveBeenCalled();
});
