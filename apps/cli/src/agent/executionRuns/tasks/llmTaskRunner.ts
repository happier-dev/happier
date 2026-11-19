import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { projectLlmTaskRunnerCandidatesFromCatalog } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { isLlmTaskRunnerAutoV1, type LlmTaskRunnerChoiceV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import {
  resolveLlmTaskRunnerV1,
  type LlmTaskIdV1,
  type LlmTaskRunnerCandidateV1,
  type LlmTaskRunnerResolutionV1,
  type LlmTaskRunnerUnavailableAgentV1,
} from '@happier-dev/protocol/llm/tasks/llmTaskRunnerSelection';

import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

export type LlmTaskRunnerMachineCandidates = Readonly<{
  candidates: readonly LlmTaskRunnerCandidateV1[];
  unavailableAgents: readonly LlmTaskRunnerUnavailableAgentV1[];
}>;

/** Typed failure for the task's existing failure/back-off owner. */
export class LlmTaskRunnerUnavailableError extends Error {
  readonly code = 'LLM_TASK_RUNNER_UNAVAILABLE' as const;
  constructor(
    readonly task: LlmTaskIdV1,
    readonly reason: Extract<LlmTaskRunnerResolutionV1, { ok: false }>['reason'],
    readonly unavailableAgents: readonly LlmTaskRunnerUnavailableAgentV1[],
  ) {
    super(reason === 'no_ready_agent'
      ? `No Agent on this machine is ready to run ${task}. Sign in to an Agent or choose one in Settings.`
      : `No ready Agent offers a model ${task} can use. Choose a model in Settings.`);
    this.name = 'LlmTaskRunnerUnavailableError';
  }
}

/**
 * This machine's ready Agents and models: enabled targets, signed in or
 * connected through a service. One reader with the summary model catalog.
 */
export async function readLlmTaskRunnerCandidatesOnThisMachine(
  services: Parameters<typeof import('@/session/actions/settingsCatalogServices').createCliSettingsCatalogServices>[0],
): Promise<LlmTaskRunnerMachineCandidates> {
  const settings = getActiveAccountSettingsSnapshot()?.settings ?? accountSettingsParse({});
  const { createCliSettingsCatalogServices } = await import('@/session/actions/settingsCatalogServices');
  const catalog = await createCliSettingsCatalogServices(services).readScmDiffSummaryCatalog?.(settings, '');
  return projectLlmTaskRunnerCandidatesFromCatalog(catalog ?? { profiles: [] });
}

/** Resolves a task's runner on this machine. Explicit choices need no machine read. */
export async function resolveLlmTaskRunnerOnThisMachine(params: Readonly<{
  task: LlmTaskIdV1;
  choice: LlmTaskRunnerChoiceV1 | null | undefined;
  sessionAgentTargetKey?: string | null;
  credentials?: StoredCredentials | null;
  signal?: AbortSignal;
  readCandidates?: () => Promise<LlmTaskRunnerMachineCandidates>;
}>): Promise<LlmTaskRunnerResolutionV1> {
  const machine = isLlmTaskRunnerAutoV1(params.choice)
    ? await (params.readCandidates ?? (() => readLlmTaskRunnerCandidatesOnThisMachine({
      ...(params.credentials ? { credentials: params.credentials } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    })))()
    : { candidates: [], unavailableAgents: [] };
  params.signal?.throwIfAborted();
  return resolveLlmTaskRunnerV1({ task: params.task, choice: params.choice, ...machine,
    ...(params.sessionAgentTargetKey !== undefined ? { sessionAgentTargetKey: params.sessionAgentTargetKey } : {}) });
}
