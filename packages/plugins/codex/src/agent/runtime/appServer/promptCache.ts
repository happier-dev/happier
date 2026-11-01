import { OPENAI_GPT56_PROMPT_CACHE_QUALIFICATION, PROMPT_CACHE_DURATIONS } from '@happier-dev/plugin-sdk/agents/runtime';

/** Native route readback qualifies the C7 fact; a display model name alone cannot. */
export function resolveCodexPromptCacheTtlMs(input: Readonly<{
  authType: string | undefined;
  modelProvider: string | null;
  modelId: string | null;
}>): number | undefined {
  const fact = PROMPT_CACHE_DURATIONS.openai;
  const qualification = OPENAI_GPT56_PROMPT_CACHE_QUALIFICATION;
  if (input.authType !== qualification.route.authType || input.modelProvider !== qualification.route.modelProvider) return undefined;
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/u.exec(input.modelId ?? '');
  if (!version) return undefined;
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);
  const minimum = qualification.minimumModelVersion;
  return major > minimum.major || (major === minimum.major && minor >= minimum.minor)
    ? fact.gpt56MinTtlMs : undefined;
}
