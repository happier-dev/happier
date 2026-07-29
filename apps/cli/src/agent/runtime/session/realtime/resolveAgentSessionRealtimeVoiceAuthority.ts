import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';
import {
  assertExperimentalAgentSessionRealtimeRuntime,
} from '@happier-dev/plugin-sdk/experimental/agent-runtime/realtime';

import type { ResolvedVoiceProviderContribution } from '@/plugins/projection/registry/types';
import type { PluginContributionRuntimeLifecycle } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { AgentSessionRealtimeVoiceAuthority } from './registerAgentSessionRealtimeVoiceRpc';

type AgentRuntimeGenerationIdentity = Readonly<{
  pluginId: string;
  agentId: string;
  generation: string;
  immutableGenerationId?: string | null;
  isCurrent(): boolean;
}>;

type VoiceAuthorityRuntimeRegistry = Readonly<{
  contributes: Readonly<{
    voiceProviders?: readonly Pick<
      ResolvedVoiceProviderContribution,
      'pluginId' | 'identity' | 'manifestDigest' | 'definition'
    >[];
  }>;
  resolveContributionRuntimeLifecycle?(input: Readonly<{
    pluginId: string;
    manifestDigest: string;
  }>): PluginContributionRuntimeLifecycle | null;
}>;

function sameRef(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function authorityKey(ref: PluginContributionIdentityV1): string {
  return `${ref.pluginId}\u0000${ref.localId}`;
}

export function snapshotAgentSessionRealtimeVoiceProviders(input: Readonly<{
  runtimeRegistry: VoiceAuthorityRuntimeRegistry;
  policyAgentRef: PluginContributionIdentityV1;
}>) {
  return (input.runtimeRegistry.contributes.voiceProviders ?? []).flatMap(
    (provider) => {
      const definition = provider.definition;
      if (
        definition.kind !== 'conversation'
        || definition.execution?.kind
          !== 'experimental_agent_session_realtime'
        || typeof definition.execution.agent !== 'object'
        || !sameRef(
          definition.execution.agent,
          input.policyAgentRef,
        )
      ) {
        return [];
      }
      const lifecycle =
        input.runtimeRegistry.resolveContributionRuntimeLifecycle?.({
          pluginId: provider.pluginId,
          manifestDigest: provider.manifestDigest,
        });
      if (
        !lifecycle
        || !lifecycle.isCurrent()
        || lifecycle.retirementSignal.aborted
      ) {
        return [];
      }
      return [Object.freeze({
        provider: Object.freeze({ ...provider, definition }),
        lifecycle,
      })];
    },
  );
}

export function resolveAgentSessionRealtimeVoiceAuthority(input: Readonly<{
  runtimeRegistry: VoiceAuthorityRuntimeRegistry | null;
  policyAgentRef: PluginContributionIdentityV1 | null;
  agentRuntimeIdentity: AgentRuntimeGenerationIdentity;
  agentRetirementSignal?: AbortSignal;
}>): AgentSessionRealtimeVoiceAuthority | null {
  const registry = input.runtimeRegistry;
  const policyAgentRef = input.policyAgentRef;
  if (
    !registry
    || !policyAgentRef
    || policyAgentRef.pluginId !== input.agentRuntimeIdentity.pluginId
    || policyAgentRef.localId !== input.agentRuntimeIdentity.agentId
  ) {
    return null;
  }

  const declarations = new Map(
    snapshotAgentSessionRealtimeVoiceProviders({
      runtimeRegistry: registry,
      policyAgentRef,
    }).flatMap(({ provider, lifecycle }) => {
      const retirementSignal = input.agentRetirementSignal
        ? AbortSignal.any([
            input.agentRetirementSignal,
            lifecycle.retirementSignal,
          ])
        : lifecycle.retirementSignal;
      return [[authorityKey(provider.identity), Object.freeze({
        declaration: provider.definition,
        lifecycle,
        retirementSignal,
      })] as const];
    }),
  );

  return Object.freeze({
    generation:
      input.agentRuntimeIdentity.immutableGenerationId
      ?? input.agentRuntimeIdentity.generation,
    policyAgentRef,
    isCurrent(provider) {
      const entry = declarations.get(authorityKey(provider));
      return Boolean(
        entry
        && !entry.retirementSignal.aborted
        && input.agentRuntimeIdentity.isCurrent()
        && entry.lifecycle.isCurrent(),
      );
    },
    resolveDeclaration(provider) {
      const entry = declarations.get(authorityKey(provider));
      return entry?.declaration ?? null;
    },
    resolveProviderGeneration(provider) {
      return declarations.get(authorityKey(provider))?.lifecycle.generation ?? null;
    },
    resolveRetirementSignal(provider) {
      return declarations.get(authorityKey(provider))?.retirementSignal ?? null;
    },
    resolveConversation({ provider, runtime }) {
      const entry = declarations.get(authorityKey(provider));
      if (
        !entry
        || entry.retirementSignal.aborted
        || !input.agentRuntimeIdentity.isCurrent()
        || !entry.lifecycle.isCurrent()
      ) {
        return null;
      }
      try {
        return Object.freeze({
          conversation:
            assertExperimentalAgentSessionRealtimeRuntime(
              runtime,
            ).realtimeConversation,
          retirementSignal: entry.retirementSignal,
        });
      } catch {
        return null;
      }
    },
  });
}
