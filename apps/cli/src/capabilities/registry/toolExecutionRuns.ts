import type { Capability, CapabilitiesDetectContext } from '../service';
import { resolveCliFeatureDecision } from '../../features/featureDecisionService';
import {
  AGENT_IDS,
  hasBuiltInAcpConfig,
  isAgentId,
  resolveAgentRuntimeControlSurfaceForSession,
} from '@happier-dev/agents';
import {
  ExecutionRunIntentSchema,
  type ExecutionRunIntent,
} from '@happier-dev/protocol';
import {
  buildExecutionRunProfileCatalog,
  listExecutionRunProfileContributionDescriptors,
  listExecutionRunSupportedIntents,
} from '../../agent/executionRuns/profiles/intentRegistry';
import { hasCatalogAcpBackendOwner } from '../../agent/acp/catalog/owner';
import { resolveCliEngineRegistry } from '../../agent/runtime/registry/engineRegistry';
import type { ResolvedAgentRuntimeContribution } from '../../plugins/projection/registry/types';
import { resolveProviderSessionRuntimePreferences } from '../../session/runtime/catalogHooks';

function isCliAvailable(context: CapabilitiesDetectContext, agentId: string): boolean {
  const clis = context?.cliSnapshot?.clis;
  if (!clis || !Object.prototype.hasOwnProperty.call(clis, agentId)) {
    return false;
  }

  const entry = clis[agentId as keyof typeof clis];
  return entry?.available === true;
}

function hasExecutionRunCatalogOwner(entry: Readonly<{
  getAcpBackendFactory?: unknown;
  getAcpRuntimeDefinitionBridge?: unknown;
  getRuntimeCore?: unknown;
}> | null | undefined): boolean {
  return hasCatalogAcpBackendOwner(entry) || typeof entry?.getRuntimeCore === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveBackendExecutionRunIntents(params: Readonly<{
  backendContribution?: ResolvedAgentRuntimeContribution;
  defaultIntents: readonly ExecutionRunIntent[];
}>): readonly ExecutionRunIntent[] {
  const executionRun = params.backendContribution?.capabilities?.executionRun;
  if (executionRun?.supported === false) return Object.freeze([]);

  const defaultIntentSet = new Set(params.defaultIntents);
  const review = isRecord(executionRun) ? executionRun.review : null;
  const declaredIntents = isRecord(review) && Array.isArray(review.intents)
    ? review.intents
    : null;
  if (!declaredIntents) {
    return params.defaultIntents;
  }

  const resolved = declaredIntents
    .map((intent) => ExecutionRunIntentSchema.safeParse(intent))
    .filter((parsed): parsed is { success: true; data: ExecutionRunIntent } => (
      parsed.success && defaultIntentSet.has(parsed.data)
    ))
    .map((parsed) => parsed.data);

  return Object.freeze(Array.from(new Set(resolved)));
}

function resolveExecutionRunBackendAvailability(params: Readonly<{
  context: CapabilitiesDetectContext;
  backendId: string;
  isKnownBuiltInAgentId: boolean;
  entry: Readonly<{
    getAcpBackendFactory?: unknown;
    getAcpRuntimeDefinitionBridge?: unknown;
    getRuntimeCore?: unknown;
  }> | null | undefined;
  backendContribution?: ResolvedAgentRuntimeContribution;
}>): boolean {
  if (params.backendContribution?.capabilities?.executionRun?.supported === false) {
    return false;
  }

  if (params.backendId === 'customAcp') {
    // Compatibility backend id used as the UI "configured ACP" entrypoint.
    return true;
  }

  if (params.isKnownBuiltInAgentId && isAgentId(params.backendId) && hasBuiltInAcpConfig(params.backendId)) {
    // Built-in ACP backends are catalog-defined and do not rely on CLI snapshot probing for
    // UI discovery in this wave.
    return true;
  }

  if (hasExecutionRunCatalogOwner(params.entry) || typeof params.backendContribution?.getRuntimeCore === 'function') {
    return true;
  }

  return isCliAvailable(params.context, params.backendId);
}

export const executionRunsCapability: Capability = {
  descriptor: { id: 'tool.executionRuns', kind: 'tool', title: 'Execution runs' },
  detect: async ({ context }) => {
    const gate = resolveCliFeatureDecision({ featureId: 'execution.runs', env: process.env });
    if (gate.state !== 'enabled') {
      return {
        available: false,
        intents: [],
        backends: {},
        disabledBy: gate.blockedBy ?? 'local_policy',
        disabledReason: gate.blockerCode,
      };
    }
    const voiceAgentDecision = resolveCliFeatureDecision({ featureId: 'voice.agent', env: process.env });
    const voiceAgentEnabled = voiceAgentDecision.state === 'enabled';

    const cliEngineRegistry = await resolveCliEngineRegistry();
    const executionRunProfileCatalog = buildExecutionRunProfileCatalog(
      (cliEngineRegistry.contributions.executionRunProfiles ?? []).map((profile) => profile.definition),
    );
    const executionRunProfiles = listExecutionRunProfileContributionDescriptors(executionRunProfileCatalog);
    const intents = voiceAgentEnabled
      ? listExecutionRunSupportedIntents()
      : listExecutionRunSupportedIntents().filter((intent) => intent !== 'voice_agent');
    const contributedBackendIds = Array.from(cliEngineRegistry.contributions.agentRuntimeDefinitionsById.keys());
    const catalogBackendIds = Object.keys(cliEngineRegistry.contributions.catalogEntriesById);
    const knownBuiltInAgentIds = AGENT_IDS;
    const backendIds = Array.from(new Set([
      ...knownBuiltInAgentIds,
      'customAcp',
      ...contributedBackendIds,
      ...catalogBackendIds,
    ]));

    const supportsVendorResumeByBackend = Object.fromEntries(
      await Promise.all(backendIds.map(async (backendId) => {
        const isKnownBuiltInAgentId = isAgentId(backendId);
        if (isKnownBuiltInAgentId) {
          const runtimePreferences = await resolveProviderSessionRuntimePreferences(backendId, {
            settings: {},
            processEnv: process.env,
            startedBy: 'daemon',
          });
          const surface = resolveAgentRuntimeControlSurfaceForSession({
            agentId: backendId,
            metadata: {},
            accountSettings: runtimePreferences,
          });
          return [backendId, surface?.resume.vendorResume !== 'unsupported'] as const;
        }
        return [backendId, false] as const;
      })),
    ) as Record<string, boolean>;

    const backends = Object.fromEntries(
      backendIds.map((backendId) => {
        const backendContribution = cliEngineRegistry.contributions.agentRuntimeDefinitionsById.get(backendId);
        const entry = cliEngineRegistry.contributions.catalogEntriesById[backendId];
        const isKnownBuiltInAgentId = isAgentId(backendId);
        const available = resolveExecutionRunBackendAvailability({
          context,
          backendId,
          isKnownBuiltInAgentId,
          entry,
          backendContribution,
        });
        return [
          backendId,
          {
            available,
            intents: resolveBackendExecutionRunIntents({ backendContribution, defaultIntents: intents }),
            supportsVendorResume: supportsVendorResumeByBackend[backendId] === true,
          },
        ] as const;
      }),
    ) as Record<string, { available: boolean; intents: readonly string[]; supportsVendorResume: boolean }>;

    return {
      available: true,
      intents,
      ...(voiceAgentEnabled
        ? {}
        : {
            disabledIntents: {
              voice_agent: {
                disabledBy: voiceAgentDecision.blockedBy ?? 'local_policy',
                disabledReason: voiceAgentDecision.blockerCode,
              },
            },
          }),
      executionRunProfiles,
      // Backend catalog is best-effort and intended for UI affordances (pickers, warnings).
      // Runtime enforcement still happens at execution-run start/send time.
      backends,
    };
  },
};
