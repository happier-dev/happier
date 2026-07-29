import type { Capability, CapabilitiesDetectContext } from '../service';
import { resolveCliFeatureDecision } from '../../features/featureDecisionService';
import {
  AGENT_IDS,
  hasBuiltInAcpConfig,
  isAgentId,
  resolveAgentRuntimeControlSurfaceForSession,
} from '@happier-dev/agents';
import {
} from '@happier-dev/protocol';
import {
  buildExecutionRunProfileCatalog,
  listExecutionRunProfileContributionDescriptors,
  listExecutionRunSupportedIntents,
  type ExecutionRunProfileContributionCatalogInput,
} from '../../agent/executionRuns/profiles/intentRegistry';
import { resolveCliEngineRegistry } from '../../agent/runtime/registry/engineRegistry';
import type { ResolvedAgentContribution } from '../../plugins/projection/registry/types';
import { readAgentExecutionRunCapabilities } from '../../plugins/projection/registry/agentContributionDefinition';
import { resolveProviderSessionRuntimePreferences } from '../../session/runtime/catalogHooks';
import {
  evaluateContributionAvailability,
  resolveInvocationContributionPolicyFacts,
} from '../../plugins/runtime/policy/evaluate';
import {
  listEngineRuntimeContributionIds,
} from '../../agent/runtime/registry/engineRegistry/contributions';

function isCliAvailable(context: CapabilitiesDetectContext, agentId: string): boolean {
  const clis = context?.cliSnapshot?.clis;
  if (!clis || !Object.prototype.hasOwnProperty.call(clis, agentId)) {
    return false;
  }

  const entry = clis[agentId as keyof typeof clis];
  return entry?.available === true;
}

function resolveExecutionRunBackendAvailability(params: Readonly<{
  context: CapabilitiesDetectContext;
  backendId: string;
  isKnownBuiltInAgentId: boolean;
  agentContribution?: ResolvedAgentContribution;
}>): boolean {
  if (params.backendId === 'customAcp') {
    // Compatibility backend id used as the UI "configured ACP" entrypoint.
    return true;
  }

  if (params.isKnownBuiltInAgentId && isAgentId(params.backendId) && hasBuiltInAcpConfig(params.backendId)) {
    // Built-in ACP backends are catalog-defined and do not rely on CLI snapshot probing for
    // UI discovery in this wave.
    return true;
  }

  if (readAgentExecutionRunCapabilities(
    params.agentContribution?.richDefinition?.definition,
  )) {
    return true;
  }

  return isCliAvailable(params.context, params.backendId);
}

export const executionRunsCapability: Capability = {
  descriptor: { id: 'tool.executionRuns', kind: 'tool', title: 'Execution runs' },
  detect: async ({ context, request }) => {
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
      (cliEngineRegistry.contributions.executionRunProfiles ?? []).flatMap<ExecutionRunProfileContributionCatalogInput>((profile) =>
        profile.pluginId ? [{ pluginId: profile.pluginId, definition: profile.definition }] : [profile.definition]),
    );
    const sessionId = typeof request.params?.sessionId === 'string' ? request.params.sessionId.trim() : '';
    const executionRunProfiles = listExecutionRunProfileContributionDescriptors(executionRunProfileCatalog)
      .flatMap((profile) => {
        const compatibleAgentIds = profile.compatibleAgents.map((reference) => (
          typeof reference === 'string' ? reference : reference.localId
        ));
        const decision = profile.availability
          ? evaluateContributionAvailability({
              availability: profile.availability,
              facts: resolveInvocationContributionPolicyFacts({
                ...(sessionId ? { sessionId } : {}),
                facts: {
                  ...(compatibleAgentIds[0] ? { 'session.agentId': compatibleAgentIds[0] } : {}),
                },
              }),
            })
          : { outcome: 'visible' as const, code: 'plugin_contribution_visible' };
        if (decision.outcome === 'hidden') return [];
        return [{
          ...profile,
          compatibleAgents: compatibleAgentIds,
          generationId: cliEngineRegistry.contributions.generationId ?? null,
          available: decision.outcome === 'visible',
          ...(decision.outcome === 'visible' ? {} : { unavailableCode: decision.code }),
        }];
      });
    const intents = voiceAgentEnabled
      ? listExecutionRunSupportedIntents()
      : listExecutionRunSupportedIntents().filter((intent) => intent !== 'voice_agent');
    const contributedBackendIds = listEngineRuntimeContributionIds(cliEngineRegistry.contributions);
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
        const agentContribution = cliEngineRegistry.contributions.agentDefinitionsById.get(backendId);
        const isKnownBuiltInAgentId = isAgentId(backendId);
        const available = resolveExecutionRunBackendAvailability({
          context,
          backendId,
          isKnownBuiltInAgentId,
          agentContribution,
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
