import type { ProviderScenario, ProviderUnderTest } from '../types';

export function assertProviderId(provider: ProviderUnderTest, expected: ProviderUnderTest['id']): void {
  if (provider.id !== expected) throw new Error(`Scenario is only supported for provider ${expected} (got ${provider.id})`);
}

export function isOpenCodeFamilyProvider(provider: ProviderUnderTest): boolean {
  return provider.id === 'opencode' || provider.id === 'opencode_server';
}

export function acpProviderId(provider: ProviderUnderTest): string {
  return provider.traceProvider ?? provider.id;
}

export function acpResumeMetadataKey(providerId: ProviderUnderTest['id']): string {
  if (providerId === 'codex') return 'codexSessionId';
  if (providerId === 'kilo') return 'kiloSessionId';
  if (providerId === 'gemini') return 'geminiSessionId';
  if (providerId === 'qwen') return 'qwenSessionId';
  if (providerId === 'kimi') return 'kimiSessionId';
  if (providerId === 'auggie') return 'auggieSessionId';
  return 'opencodeSessionId';
}

export function claudeAgentTeamsCreateAndSpawnPrompt(teamId: string): string {
  return [
    'This is an automated E2E test for Claude Code Agent Teams.',
    'You MUST execute the following tool calls, in order:',
    '',
    `1) TeamCreate: create a team with team_name="${teamId}".`,
    '2) Task: spawn teammate Alpha (run_in_background=true).',
    '3) Task: spawn teammate Beta (run_in_background=true).',
    '',
    'Rules:',
    '- Do not use Bash.',
    '- Do not read or write files.',
    '- Do not answer until steps 1–3 are complete.',
    '- Then reply DONE.',
    '',
    'If you do not see the TeamCreate tool available, reply ONLY: NO_AGENT_TEAMS.',
  ].join('\n');
}

export function abortContinuationFollowupSubstrings(
  providerId: ProviderUnderTest['id'],
  followupSentinel: string,
  memorySentinel: string,
): string[] {
  if (providerId === 'kimi' || providerId === 'auggie' || providerId === 'kilo' || providerId === 'pi') return [followupSentinel];
  return [followupSentinel, memorySentinel];
}

function relaxAuggieResumeScenario(provider: ProviderUnderTest, scenario: ProviderScenario): ProviderScenario {
  if (provider.id !== 'auggie') return scenario;
  return {
    ...scenario,
    requiredAnyFixtureKeys: undefined,
    requiredTraceSubstrings: undefined,
  };
}

export function tuneResumeScenarioForProvider(provider: ProviderUnderTest, scenario: ProviderScenario): ProviderScenario {
  const auggieRelaxed = relaxAuggieResumeScenario(provider, scenario);
  if (provider.id !== 'codex') return auggieRelaxed;
  return {
    ...auggieRelaxed,
    inactivityTimeoutMs: 240_000,
  };
}

function appendKimiUnknownFixtureAlias(key: string): string[] {
  const normalized = key.trim();
  if (!normalized.startsWith('acp/kimi/')) return [key];
  const parts = normalized.split('/');
  if (parts.length !== 4) return [key];
  const kind = parts[2];
  const toolName = parts[3];
  if (toolName === 'unknown') return [key];
  if (kind !== 'tool-call' && kind !== 'tool-result' && kind !== 'permission-request') return [key];
  return [key, `acp/kimi/${kind}/unknown`];
}

export function withKimiUnknownToolFixtureAliases(provider: ProviderUnderTest, scenario: ProviderScenario): ProviderScenario {
  if (provider.id !== 'kimi') return scenario;

  const dedupeKeys = (keys: string[] | undefined): string[] | undefined => {
    if (!Array.isArray(keys) || keys.length === 0) return keys;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  };

  const dedupeAliasBucket = (bucket: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const key of bucket) {
      for (const alias of appendKimiUnknownFixtureAlias(key)) {
        if (seen.has(alias)) continue;
        seen.add(alias);
        out.push(alias);
      }
    }
    return out;
  };

  const dedupeBuckets = (buckets: string[][] | undefined): string[][] | undefined => {
    if (!Array.isArray(buckets) || buckets.length === 0) return buckets;
    return buckets.map((bucket) => dedupeAliasBucket(bucket));
  };

  const aliasRequiredKeysIntoAnyBuckets = (
    keys: string[] | undefined,
  ): { requiredFixtureKeys: string[] | undefined; requiredAnyFixtureKeys: string[][] | undefined } => {
    if (!Array.isArray(keys) || keys.length === 0) {
      return { requiredFixtureKeys: keys, requiredAnyFixtureKeys: undefined };
    }

    const requiredFixtureKeys: string[] = [];
    const requiredAnyFixtureKeys: string[][] = [];
    for (const key of keys) {
      const aliases = dedupeKeys(appendKimiUnknownFixtureAlias(key)) ?? [key];
      if (aliases.length <= 1) {
        requiredFixtureKeys.push(key);
        continue;
      }
      requiredAnyFixtureKeys.push(aliases);
    }

    return {
      requiredFixtureKeys: dedupeKeys(requiredFixtureKeys),
      requiredAnyFixtureKeys: dedupeBuckets(requiredAnyFixtureKeys),
    };
  };

  const mergeAnyBuckets = (left: string[][] | undefined, right: string[][] | undefined): string[][] | undefined => {
    if (!left && !right) return undefined;
    return dedupeBuckets([...(left ?? []), ...(right ?? [])]);
  };

  const steps = Array.isArray(scenario.steps)
    ? scenario.steps.map((step) => {
      if (!step?.satisfaction) return step;
      const split = aliasRequiredKeysIntoAnyBuckets(step.satisfaction.requiredFixtureKeys);
      return {
        ...step,
        satisfaction: {
          ...step.satisfaction,
          requiredFixtureKeys: split.requiredFixtureKeys,
          requiredAnyFixtureKeys: mergeAnyBuckets(
            split.requiredAnyFixtureKeys,
            dedupeBuckets(step.satisfaction.requiredAnyFixtureKeys),
          ),
        },
      };
    })
    : scenario.steps;

  const split = aliasRequiredKeysIntoAnyBuckets(scenario.requiredFixtureKeys);
  return {
    ...scenario,
    requiredFixtureKeys: split.requiredFixtureKeys,
    requiredAnyFixtureKeys: mergeAnyBuckets(
      split.requiredAnyFixtureKeys,
      dedupeBuckets(scenario.requiredAnyFixtureKeys),
    ),
    steps,
  };
}
