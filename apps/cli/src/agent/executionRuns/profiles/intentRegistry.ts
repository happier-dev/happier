import type {
  ExecutionRunIntent,
  PluginExecutionRunProfileContributionV2,
  PromptBlockV1,
} from '@happier-dev/protocol';
import {
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  ReviewCommentProposalsV1Schema,
} from '@happier-dev/protocol';

import type { ExecutionRunIntentProfile } from './ExecutionRunIntentProfile';
import { ReviewProfile } from './review/ReviewProfile';
import { PlanProfile } from './plan/PlanProfile';
import { DelegateProfile } from './delegate/DelegateProfile';
import { VoiceAgentProfile } from './voiceAgent/VoiceAgentProfile';
import { MemoryHintsProfile } from './memoryHints/MemoryHintsProfile';
import { ScmCommitMessageProfile } from '@/agent/runtime/bridges/executionRun/kinds/scmCommitMessage/ScmCommitMessageProfile';
import { ScmDiffSummaryProfile } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/ScmDiffSummaryProfile';
import {
  evaluateContributionAvailability,
  type ContributionPolicyFacts,
} from '@/plugins/runtime/policy/evaluate';

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
  profileDescriptorsById: ReadonlyMap<string, OwnedExecutionRunProfileDescriptor>;
  profileDescriptorIdsByIntent: ReadonlyMap<ExecutionRunIntent, readonly string[]>;
  runtimeProfilesById: ReadonlyMap<string, ExecutionRunIntentProfile>;
}>;

export type ExecutionRunProfileContributionCatalogInput =
  | PluginExecutionRunProfileContributionV2
  | Readonly<{ pluginId: string; definition: PluginExecutionRunProfileContributionV2 }>;

export type OwnedExecutionRunProfileDescriptor = Readonly<{
  pluginId: string | null;
  qualifiedId: string;
  definition: PluginExecutionRunProfileContributionV2;
}>;

export type ExecutionRunProfileCatalogOptions = Readonly<{
  generationId?: string;
  resolveAgentIdentity?: (agentId: string) => Readonly<{
    pluginId: string;
    localId: string;
  }> | null;
  resolvePolicyFacts?: (params: Readonly<{
    descriptor: OwnedExecutionRunProfileDescriptor;
    agentId: string;
    request: Parameters<NonNullable<ExecutionRunIntentProfile['prepareStartParams']>>[0]['request'];
  }>) => ContributionPolicyFacts;
  resolvePromptAssetBlocks?: (params: Readonly<{
    descriptor: OwnedExecutionRunProfileDescriptor;
    promptAsset: Readonly<{ pluginId: string; localId: string }>;
    agentId: string;
    request: Parameters<NonNullable<ExecutionRunIntentProfile['prepareStartParams']>>[0]['request'];
    cwd: string;
  }>) => Promise<readonly PromptBlockV1[]>;
}>;

function failProfileSelection(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function qualifyReference(
  ownerPluginId: string | null,
  reference: PluginExecutionRunProfileContributionV2['promptAsset'],
): Readonly<{ pluginId: string; localId: string }> {
  if (typeof reference !== 'string') return reference;
  if (!ownerPluginId) {
    return failProfileSelection(
      'execution_run_profile_identity_invalid',
      'Unowned execution-run profiles must use qualified contribution references',
    );
  }
  return Object.freeze({ pluginId: ownerPluginId, localId: reference });
}

function resolveCompatibleAgentId(
  descriptor: OwnedExecutionRunProfileDescriptor,
  request: Parameters<NonNullable<ExecutionRunIntentProfile['prepareStartParams']>>[0]['request'],
  options: ExecutionRunProfileCatalogOptions,
): string {
  const requestedAgentId = request.backendTarget.kind === 'builtInAgent'
    ? request.backendTarget.agentId
    : request.backendTarget.kind === 'backend' && request.backendTarget.sourceKind !== 'configured'
      ? request.backendTarget.backendId
      : null;
  if (!requestedAgentId) {
    return failProfileSelection(
      'execution_run_profile_agent_incompatible',
      `Execution-run profile '${descriptor.qualifiedId}' is not compatible with the selected Agent`,
    );
  }
  const requestedIdentity = options.resolveAgentIdentity
    ? options.resolveAgentIdentity(requestedAgentId)
    : null;
  const compatible = descriptor.definition.compatibleAgents.some((reference) => {
    if (!requestedIdentity) {
      return (typeof reference === 'string' ? reference : reference.localId) === requestedAgentId;
    }
    const compatibleIdentity = typeof reference === 'string'
      ? descriptor.pluginId
        ? { pluginId: descriptor.pluginId, localId: reference }
        : null
      : reference;
    return compatibleIdentity?.pluginId === requestedIdentity.pluginId
      && compatibleIdentity.localId === requestedIdentity.localId;
  });
  if (!compatible || (options.resolveAgentIdentity && !requestedIdentity)) {
    return failProfileSelection(
      'execution_run_profile_agent_incompatible',
      `Execution-run profile '${descriptor.qualifiedId}' is not compatible with the selected Agent`,
    );
  }
  return requestedAgentId;
}

function profileDefaultsPatch(
  descriptor: PluginExecutionRunProfileContributionV2,
): Readonly<{ retentionPolicy: 'ephemeral' | 'resumable'; runClass: 'bounded' | 'long_lived'; ioMode: 'request_response' | 'streaming' }> {
  return Object.freeze({
    retentionPolicy: descriptor.defaults.retention,
    runClass: descriptor.defaults.runClass === 'longLived' ? 'long_lived' : 'bounded',
    ioMode: descriptor.defaults.io === 'requestResponse' ? 'request_response' : 'streaming',
  });
}

function normalizeDescriptor(input: ExecutionRunProfileContributionCatalogInput): OwnedExecutionRunProfileDescriptor {
  const owned = 'definition' in input;
  const definition = owned ? input.definition : input;
  const pluginId = owned ? input.pluginId : null;
  return {
    pluginId,
    qualifiedId: pluginId
      ? buildQualifiedPluginContributionKey(createPluginContributionIdentity({ pluginId, localId: definition.id }))
      : definition.id,
    definition,
  };
}

function withDescriptorBehavior(
  baseProfile: ExecutionRunIntentProfile,
  ownedDescriptor: OwnedExecutionRunProfileDescriptor,
  options: ExecutionRunProfileCatalogOptions,
): ExecutionRunIntentProfile {
  const descriptor = ownedDescriptor.definition;
  const actionIds = (descriptor.actions ?? []).flatMap((reference) => {
    if (reference.kind === 'hostAction') {
      return baseProfile.intent === 'review' ? [reference.actionId] : [];
    }
    return typeof reference.action === 'string'
      ? [ownedDescriptor.pluginId
        ? buildQualifiedPluginContributionKey(createPluginContributionIdentity({
          pluginId: ownedDescriptor.pluginId,
          localId: reference.action,
        }))
        : reference.action]
      : [`${reference.action.pluginId}/${reference.action.localId}`];
  });
  return Object.freeze({
    ...baseProfile,
    prepareStartParams: async (params) => {
      const requestedGenerationId = typeof params.request.profileGenerationId === 'string'
        ? params.request.profileGenerationId.trim()
        : '';
      if (options.generationId && requestedGenerationId !== options.generationId) {
        return failProfileSelection(
          'execution_run_profile_stale',
          `Execution-run profile '${ownedDescriptor.qualifiedId}' is not from the current committed generation`,
        );
      }
      const agentId = resolveCompatibleAgentId(ownedDescriptor, params.request, options);
      if (descriptor.availability) {
        const facts = options.resolvePolicyFacts?.({
          descriptor: ownedDescriptor,
          agentId,
          request: params.request,
        });
        const availability = facts
          ? evaluateContributionAvailability({ availability: descriptor.availability, facts })
          : { outcome: 'unavailable' as const, code: 'plugin_contribution_policy_fact_unavailable' };
        if (availability.outcome !== 'visible') {
          return failProfileSelection(
            availability.outcome === 'disabled'
              ? 'execution_run_profile_disabled'
              : 'execution_run_profile_unavailable',
            `Execution-run profile '${ownedDescriptor.qualifiedId}' is unavailable (${availability.code})`,
          );
        }
      }
      const promptAsset = qualifyReference(ownedDescriptor.pluginId, descriptor.promptAsset);
      const promptAssetBlocks = options.resolvePromptAssetBlocks
        ? await options.resolvePromptAssetBlocks({
          descriptor: ownedDescriptor,
          promptAsset,
          agentId,
          request: params.request,
          cwd: params.cwd,
        })
        : Object.freeze([]);
      const basePatch = await baseProfile.prepareStartParams?.(params);
      const baseInstructions = typeof basePatch?.instructions === 'string'
        ? basePatch.instructions
        : params.request.instructions ?? '';
      const promptAssetText = promptAssetBlocks.map((block) => block.text).filter((text) => text.trim()).join('\n\n');
      return Object.freeze({
        ...(basePatch ?? {}),
        ...profileDefaultsPatch(descriptor),
        ...(promptAssetText ? {
          instructions: baseInstructions
            ? `${promptAssetText}\n\n${baseInstructions}`
            : promptAssetText,
        } : {}),
      });
    },
    listAvailableActionIds: (params) => {
      const proposalPayload = params.structuredMeta?.kind === 'review_findings.v2'
        && params.structuredMeta.payload
        && typeof params.structuredMeta.payload === 'object'
        && !Array.isArray(params.structuredMeta.payload)
        ? (params.structuredMeta.payload as { proposedComments?: unknown }).proposedComments
        : undefined;
      const proposals = ReviewCommentProposalsV1Schema.safeParse(proposalPayload);
      const payloadRecord = params.structuredMeta?.payload && typeof params.structuredMeta.payload === 'object'
        ? params.structuredMeta.payload as { runRef?: { runId?: unknown; callId?: unknown } }
        : null;
      const matchingRun = Boolean(
        payloadRecord?.runRef
        && payloadRecord.runRef.runId === params.start.runId
        && payloadRecord.runRef.callId === params.start.callId,
      );
      const exposeReviewComments = proposals.success && proposals.data.length > 0 && matchingRun;
      const exposedDescriptorActions = actionIds.filter(
        (actionId) => actionId !== 'reviews.comments.create' || exposeReviewComments,
      );
      return Object.freeze(Array.from(new Set([
        ...(baseProfile.listAvailableActionIds?.(params) ?? []),
        ...exposedDescriptorActions,
      ])));
    },
  });
}

export function buildExecutionRunProfileCatalog(
  profileDescriptors: readonly ExecutionRunProfileContributionCatalogInput[] = [],
  options: ExecutionRunProfileCatalogOptions = {},
): ExecutionRunProfileContributionCatalog {
  const profileDescriptorsById = new Map<string, OwnedExecutionRunProfileDescriptor>();
  const profileDescriptorIdsByIntent = new Map<ExecutionRunIntent, string[]>();
  const runtimeProfilesById = new Map<string, ExecutionRunIntentProfile>();

  for (const input of profileDescriptors) {
    const descriptor = normalizeDescriptor(input);
    if (profileDescriptorsById.has(descriptor.qualifiedId)) {
      throw new Error(`Duplicate execution-run profile contribution '${descriptor.qualifiedId}'`);
    }
    profileDescriptorsById.set(descriptor.qualifiedId, descriptor);
    const intentIds = profileDescriptorIdsByIntent.get(descriptor.definition.intent) ?? [];
    intentIds.push(descriptor.qualifiedId);
    profileDescriptorIdsByIntent.set(descriptor.definition.intent, intentIds);
    const baseProfile = BUILT_IN_PROFILE_MAP.get(descriptor.definition.intent);
    if (!baseProfile) {
      return failProfileSelection(
        'execution_run_profile_intent_unsupported',
        `Execution-run profile '${descriptor.qualifiedId}' declares an unsupported intent`,
      );
    }
    runtimeProfilesById.set(
      descriptor.qualifiedId,
      withDescriptorBehavior(baseProfile, descriptor, options),
    );
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
    if (!descriptor) {
      return failProfileSelection(
        'execution_run_profile_stale',
        `Execution-run profile '${normalizedProfileId}' is unknown or stale`,
      );
    }
    if (descriptor.definition.intent !== intent) {
      return failProfileSelection(
        'execution_run_profile_intent_mismatch',
        `Execution-run profile '${normalizedProfileId}' does not own intent '${intent}'`,
      );
    }
    const runtimeProfile = catalog.runtimeProfilesById.get(normalizedProfileId);
    if (!runtimeProfile) {
      return failProfileSelection(
        'execution_run_profile_runtime_unavailable',
        `Execution-run profile '${normalizedProfileId}' has no runtime profile`,
      );
    }
    return runtimeProfile;
  }

  return catalog.builtInProfilesByIntent.get(intent) ?? resolveExecutionRunIntentProfile(intent);
}

export function resolveExecutionRunProfileContributionDescriptor(
  catalog: ExecutionRunProfileContributionCatalog,
  profileId: string,
): PluginExecutionRunProfileContributionV2 | null {
  const descriptor = catalog.profileDescriptorsById.get(profileId);
  return descriptor ? { ...descriptor.definition, id: descriptor.qualifiedId } : null;
}

export function listExecutionRunProfileContributionDescriptors(
  catalog: ExecutionRunProfileContributionCatalog,
): readonly PluginExecutionRunProfileContributionV2[] {
  return Object.freeze(Array.from(catalog.profileDescriptorsById.values()).map((descriptor) => {
    return Object.freeze({ ...descriptor.definition, id: descriptor.qualifiedId });
  }));
}
