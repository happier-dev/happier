import { FIRST_PARTY_SKILLS_V1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';

/** Preview and delivery share the Home observation and canonical Account feature decisions. */
export async function resolveFirstPartySkillFeatures(input: Readonly<{
  serverUrl: string;
  env: Parameters<typeof resolveCliFeatureDecision>[0]['env'];
  settings: Parameters<typeof resolveCliFeatureDecision>[0]['settings'];
  signal?: AbortSignal;
}>): Promise<Readonly<Partial<Record<FeatureId, boolean>>>> {
  const serverSnapshot = await fetchServerFeaturesSnapshot({ serverUrl: input.serverUrl, signal: input.signal });
  const enabled: Partial<Record<FeatureId, boolean>> = {};
  for (const skill of FIRST_PARTY_SKILLS_V1) if (skill.requiresFeature && enabled[skill.requiresFeature] === undefined) {
    enabled[skill.requiresFeature] = resolveCliFeatureDecision({ featureId: skill.requiresFeature,
      env: input.env, settings: input.settings, serverSnapshot }).state === 'enabled';
  }
  return enabled;
}
