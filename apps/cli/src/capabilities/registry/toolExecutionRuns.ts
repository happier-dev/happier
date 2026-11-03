import type { Capability } from '../service';
import { resolveCliFeatureDecision } from '../../features/featureDecisionService';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import {
  listExecutionRunProfileContributionDescriptors,
  listExecutionRunSupportedIntents,
} from '../../agent/executionRuns/profiles/intentRegistry';
import { resolveCliEngineRegistry } from '../../agent/runtime/registry/engineRegistry';
import type { ResolvedAgentContribution } from '../../plugins/projection/registry/types';
import { readAgentExecutionRunCapabilities } from '../../plugins/projection/registry/agentContributionDefinition';
import { readAgentSessionCapabilities } from '../../plugins/projection/registry/agentContributionDefinition';
import { selectReviewEngineAgentIds } from '../../session/actions/inventory/buildReviewEngineInventoryItems';
import { buildConfiguredAcpBackendInventoryItems } from '../../session/actions/inventory/buildAgentBackendInventoryItems';
import { getActiveAccountSettingsSnapshot } from '../../settings/accountSettings/activeAccountSettingsSnapshot';
import {
  evaluateContributionAvailability,
  resolveInvocationContributionPolicyFacts,
} from '../../plugins/runtime/policy/evaluate';

function resolveExecutionRunBackendAvailability(params: Readonly<{
  agentContribution?: ResolvedAgentContribution;
}>): boolean {
  if (readAgentExecutionRunCapabilities(
    params.agentContribution?.richDefinition?.definition,
  )) {
    return true;
  }

  if (readAgentSessionCapabilities(params.agentContribution?.richDefinition?.definition)) {
    return true;
  }

  return false;
}

export const executionRunsCapability: Capability = {
  effects: { detect: ['private_read'] },
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
    const executionRunProfileCatalog = await cliEngineRegistry.resolveExecutionRunProfileCatalog();
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
          available: decision.outcome === 'visible',
          ...(decision.outcome === 'visible' ? {} : { unavailableCode: decision.code }),
        }];
      });
    const activatableIntents = listExecutionRunSupportedIntents();
    const intents = voiceAgentEnabled
      ? activatableIntents
      : activatableIntents.filter((intent) => intent !== 'voice_agent');
    const reviewEngineAgentIds = selectReviewEngineAgentIds(cliEngineRegistry.contributions);
    const exactPathReviewEngineAgentIds = selectReviewEngineAgentIds(cliEngineRegistry.contributions, 'paths');
    const accountSnapshot = getActiveAccountSettingsSnapshot();
    // Configured targets are best-effort discovery, not the daemon's protocol
    // authority. An unobserved ACP catalog cannot withdraw built-in Run support;
    // configured starts still require its ready authority at their own owner.
    const configuredBackends = await buildConfiguredAcpBackendInventoryItems(
      accountSnapshot?.settings ?? null, accountSnapshot?.acpCatalog,
    );
    const backendIds = [...cliEngineRegistry.contributions.agentDefinitionsById.values()]
      .filter((agent) => agent.identity && listAgentExecutionTargetsV1(agent.identity).length > 0)
      .map((agent) => agent.id);

    const supportsVendorResumeByBackend = Object.fromEntries(
      backendIds.map((backendId) => [
        backendId,
        // This UI capability has no Session runtime selection. Only the
        // manifest's unconditional support fact is affirmative here; an
        // experimental Agent is decided later by the canonical spawn gate.
        cliEngineRegistry.contributions.catalogEntriesById[backendId]?.vendorResumeSupport === 'supported',
      ] as const),
    ) as Record<string, boolean>;

    const backends = Object.fromEntries([
      ...backendIds.map((backendId) => {
        const agentContribution = cliEngineRegistry.contributions.agentDefinitionsById.get(backendId);
        const available = resolveExecutionRunBackendAvailability({
          agentContribution,
        });
        return [
          backendId,
          {
            available,
            intents: reviewEngineAgentIds.has(backendId)
              ? intents
              : intents.filter((intent) => intent !== 'review'),
            reviewScopes: reviewEngineAgentIds.has(backendId)
              ? exactPathReviewEngineAgentIds.has(backendId) ? ['worktree', 'paths'] : ['worktree']
              : [],
            supportsVendorResume: supportsVendorResumeByBackend[backendId] === true,
          },
        ] as const;
      }),
      ...configuredBackends.map((backend) => [
        backend.targetKey,
        {
          available: backend.enabled,
          intents: backend.enabled ? intents : intents.filter((intent) => intent !== 'review'),
          reviewScopes: backend.enabled ? ['worktree', 'paths'] : [],
          supportsVendorResume: false,
          title: backend.label,
        },
      ] as const),
    ]) as Record<string, { available: boolean; intents: readonly string[]; supportsVendorResume: boolean }>;

    return {
      available: true,
      // V2 is a capability-local contract. Callers must observe these exact
      // facts from their selected daemon before they send detached scope or
      // start-and-wait fields; the outer capabilities protocol remains V1.
      protocolVersion: 2,
      features: {
        detachedScope: true,
        startAndWait: true,
        exactInputResults: true,
        runScopedAgentBindings: true,
        secretReferenceOverlay: true,
      },
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
