import type { Capability, CapabilitiesDetectContext } from '../service';
import { resolveCliFeatureDecision } from '../../features/featureDecisionService';
import {
  CANONICAL_AGENT_IDS,
  hasBuiltInAcpConfig,
  isAgentId,
  resolveAgentRuntimeControlSurface,
  resolveDefaultAgentRuntimeKind,
  resolveCodexSpawnExtrasForRuntime,
} from '@happier-dev/agents';
import {
  buildExecutionRunProfileCatalog,
  listExecutionRunProfileContributionDescriptors,
  listExecutionRunSupportedIntents,
} from '../../agent/executionRuns/profiles/intentRegistry';
import { resolveCliEngineRegistry } from '../../agent/runtime/registry/engineRegistry';
import type { ResolvedBackendContribution } from '../../plugins/projection/registry/types';

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
  getRuntimeCore?: unknown;
}> | null | undefined): boolean {
  return typeof entry?.getAcpBackendFactory === 'function' || typeof entry?.getRuntimeCore === 'function';
}

function resolveExecutionRunBackendAvailability(params: Readonly<{
  context: CapabilitiesDetectContext;
  backendId: string;
  isKnownBuiltInAgentId: boolean;
  entry: Readonly<{
    getAcpBackendFactory?: unknown;
    getRuntimeCore?: unknown;
  }> | null | undefined;
  backendContribution?: ResolvedBackendContribution;
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
    const voiceEnabled = resolveCliFeatureDecision({ featureId: 'voice', env: process.env }).state === 'enabled';

    const cliEngineRegistry = await resolveCliEngineRegistry();
    const executionRunProfileCatalog = buildExecutionRunProfileCatalog(
      (cliEngineRegistry.contributions.executionRunProfiles ?? []).map((profile) => profile.definition),
    );
    const executionRunProfiles = listExecutionRunProfileContributionDescriptors(executionRunProfileCatalog);
    const intents = voiceEnabled
      ? listExecutionRunSupportedIntents()
      : listExecutionRunSupportedIntents().filter((intent) => intent !== 'voice_agent');
    const contributedBackendIds = Array.from(cliEngineRegistry.contributions.backendDefinitionsById.keys());
    const catalogBackendIds = Object.keys(cliEngineRegistry.contributions.catalogEntriesById);
    const knownBuiltInAgentIds = CANONICAL_AGENT_IDS;
    const backendIds = Array.from(new Set([
      ...knownBuiltInAgentIds,
      'customAcp',
      ...contributedBackendIds,
      ...catalogBackendIds,
    ]));

    const supportsVendorResumeByBackend = Object.fromEntries(
      backendIds.map((backendId) => {
        const isKnownBuiltInAgentId = isAgentId(backendId);
        if (isKnownBuiltInAgentId) {
          const surface = backendId === 'codex'
            ? (() => {
              const codexExtras = resolveCodexSpawnExtrasForRuntime({ settings: {}, processEnv: process.env });
              const runtimeKind = (codexExtras.codexBackendMode ?? resolveDefaultAgentRuntimeKind('codex')) ?? null;
              return resolveAgentRuntimeControlSurface('codex', runtimeKind);
            })()
            : resolveAgentRuntimeControlSurface(backendId, null);
          return [backendId, surface.resume.vendorResume !== 'unsupported'] as const;
        }
        return [backendId, false] as const;
      }),
    ) as Record<string, boolean>;

    const backends = Object.fromEntries(
      backendIds.map((backendId) => {
        const backendContribution = cliEngineRegistry.contributions.backendDefinitionsById.get(backendId);
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
            intents,
            supportsVendorResume: supportsVendorResumeByBackend[backendId] === true,
          },
        ] as const;
      }),
    ) as Record<string, { available: boolean; intents: readonly string[]; supportsVendorResume: boolean }>;

    return {
      available: true,
      intents,
      executionRunProfiles,
      // Backend catalog is best-effort and intended for UI affordances (pickers, warnings).
      // Runtime enforcement still happens at execution-run start/send time.
      backends,
    };
  },
};
