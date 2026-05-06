import type {
  ExecutionRunIntent,
  PluginExecutionRunProfileContributionV2,
} from '@happier-dev/protocol';

import type { ExecutionRunIntentProfile } from './ExecutionRunIntentProfile';
import { ReviewProfile } from './review/ReviewProfile';
import { PlanProfile } from './plan/PlanProfile';
import { DelegateProfile } from './delegate/DelegateProfile';
import { VoiceAgentProfile } from './voiceAgent/VoiceAgentProfile';
import { MemoryHintsProfile } from './memoryHints/MemoryHintsProfile';
import { ScmCommitMessageProfile } from '@/agent/runtime/bridges/executionRun/kinds/scmCommitMessage/ScmCommitMessageProfile';
import { ScmDiffSummaryProfile } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/ScmDiffSummaryProfile';

const PROFILES: Record<ExecutionRunIntent, ExecutionRunIntentProfile> = {
  review: ReviewProfile,
  plan: PlanProfile,
  delegate: DelegateProfile,
  voice_agent: VoiceAgentProfile,
  memory_hints: MemoryHintsProfile,
  scm_commit_message: ScmCommitMessageProfile,
  scm_diff_summary: ScmDiffSummaryProfile,
};

const BUILT_IN_PROFILE_MAP: ReadonlyMap<ExecutionRunIntent, ExecutionRunIntentProfile> = Object.freeze(
  new Map(Object.entries(PROFILES) as [ExecutionRunIntent, ExecutionRunIntentProfile][]),
);

export type ExecutionRunProfileContributionCatalog = Readonly<{
  builtInProfilesByIntent: ReadonlyMap<ExecutionRunIntent, ExecutionRunIntentProfile>;
  profileDescriptorsById: ReadonlyMap<string, PluginExecutionRunProfileContributionV2>;
  profileDescriptorIdsByIntent: ReadonlyMap<ExecutionRunIntent, readonly string[]>;
  runtimeProfilesById: ReadonlyMap<string, ExecutionRunIntentProfile>;
}>;

function withDescriptorActionIds(
  baseProfile: ExecutionRunIntentProfile,
  descriptor: PluginExecutionRunProfileContributionV2,
): ExecutionRunIntentProfile {
  if (descriptor.actionIds.length === 0) {
    return baseProfile;
  }

  return Object.freeze({
    ...baseProfile,
    listAvailableActionIds: (params) => Object.freeze(Array.from(new Set([
      ...(baseProfile.listAvailableActionIds?.(params) ?? []),
      ...descriptor.actionIds,
    ]))),
  });
}

export function buildExecutionRunProfileCatalog(
  profileDescriptors: readonly PluginExecutionRunProfileContributionV2[] = [],
): ExecutionRunProfileContributionCatalog {
  const profileDescriptorsById = new Map<string, PluginExecutionRunProfileContributionV2>();
  const profileDescriptorIdsByIntent = new Map<ExecutionRunIntent, string[]>();
  const runtimeProfilesById = new Map<string, ExecutionRunIntentProfile>();

  for (const descriptor of profileDescriptors) {
    if (profileDescriptorsById.has(descriptor.id)) {
      throw new Error(`Duplicate execution-run profile contribution '${descriptor.id}'`);
    }
    const builtInProfile = BUILT_IN_PROFILE_MAP.get(descriptor.intent);
    if (!builtInProfile) {
      throw new Error(`Execution-run profile contribution '${descriptor.id}' references unsupported intent '${descriptor.intent}'`);
    }
    profileDescriptorsById.set(descriptor.id, descriptor);
    runtimeProfilesById.set(descriptor.id, withDescriptorActionIds(builtInProfile, descriptor));
    const idsForIntent = profileDescriptorIdsByIntent.get(descriptor.intent) ?? [];
    idsForIntent.push(descriptor.id);
    profileDescriptorIdsByIntent.set(descriptor.intent, idsForIntent);
  }

  return Object.freeze({
    builtInProfilesByIntent: BUILT_IN_PROFILE_MAP,
    profileDescriptorsById: Object.freeze(profileDescriptorsById),
    profileDescriptorIdsByIntent: Object.freeze(new Map(
      Array.from(profileDescriptorIdsByIntent.entries()).map(([intent, ids]) => [
        intent,
        Object.freeze([...ids]),
      ] as const),
    )),
    runtimeProfilesById: Object.freeze(runtimeProfilesById),
  });
}

export function listExecutionRunSupportedIntents(): readonly ExecutionRunIntent[] {
  return Object.freeze(Array.from(BUILT_IN_PROFILE_MAP.keys()));
}

export function resolveExecutionRunIntentProfile(intent: ExecutionRunIntent): ExecutionRunIntentProfile {
  const profile = BUILT_IN_PROFILE_MAP.get(intent);
  if (!profile) {
    throw new Error(`Unsupported execution-run intent '${intent}'`);
  }
  return profile;
}

export function resolveExecutionRunIntentProfileFromCatalog(
  catalog: ExecutionRunProfileContributionCatalog,
  intent: ExecutionRunIntent,
  profileId?: string | null,
): ExecutionRunIntentProfile {
  const normalizedProfileId = typeof profileId === 'string' ? profileId.trim() : '';
  if (normalizedProfileId.length > 0) {
    const descriptor = catalog.profileDescriptorsById.get(normalizedProfileId) ?? null;
    const runtimeProfile = catalog.runtimeProfilesById.get(normalizedProfileId) ?? null;
    if (descriptor?.intent === intent && runtimeProfile) {
      return runtimeProfile;
    }
  }

  return catalog.builtInProfilesByIntent.get(intent) ?? resolveExecutionRunIntentProfile(intent);
}

export function resolveExecutionRunProfileContributionDescriptor(
  catalog: ExecutionRunProfileContributionCatalog,
  profileId: string,
): PluginExecutionRunProfileContributionV2 | null {
  return catalog.profileDescriptorsById.get(profileId) ?? null;
}

export function listExecutionRunProfileContributionDescriptors(
  catalog: ExecutionRunProfileContributionCatalog,
): readonly PluginExecutionRunProfileContributionV2[] {
  return Object.freeze(Array.from(catalog.profileDescriptorsById.values()));
}
