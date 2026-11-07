import type {
  PluginContributionIdentityV1,
  PluginSourceCustodyV1,
  VoiceProviderContribution,
} from '@happier-dev/protocol';
import type { PluginRuntimeHookOperations } from '@/plugins/runtime/runtimeCore/plugin/sessionRuntimeHooks';
import type { ResolvedVoiceProviderContribution } from '@/plugins/projection/registry/types';
import type { PluginContributionRuntimeLifecycle } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
  verifyAgentSessionRunnerBindingV1,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type { AgentSessionRealtimeVoiceAuthority } from './registerAgentSessionRealtimeVoiceRpc';

type AgentRuntimeIdentity = Readonly<{
  pluginId: string;
  agentId: string;
  localAgentId?: string;
  occurrenceId: string;
  sourceCustody: PluginSourceCustodyV1;
  isCurrent(): boolean;
}>;

type VoiceAuthorityRuntimeRegistry = Readonly<{
  contributes: Readonly<{
    voiceProviders?: readonly Pick<
      ResolvedVoiceProviderContribution,
      'pluginId' | 'identity' | 'definition'
    >[];
  }>;
  resolveVoiceProviderRuntimeLifecycle?(
    identity: PluginContributionIdentityV1,
  ): PluginContributionRuntimeLifecycle | null;
}>;

type ConversationDeclaration = Extract<
  VoiceProviderContribution,
  Readonly<{ kind: 'conversation' }>
>;

type AgentSessionRealtimeVoicePolicyProvider = Readonly<{
  provider: PluginContributionIdentityV1;
  declaration: ConversationDeclaration;
  occurrenceId: string;
  isCurrent(): boolean;
  retirementSignal: AbortSignal;
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

function isEligibleAgentSessionRealtimeVoiceDeclaration(
  declaration: ConversationDeclaration,
  policyAgentRef: PluginContributionIdentityV1,
): boolean {
  return declaration.execution?.kind
    === 'experimental_agent_session_realtime'
    && typeof declaration.execution.agent === 'object'
    && sameRef(declaration.execution.agent, policyAgentRef);
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
        || !isEligibleAgentSessionRealtimeVoiceDeclaration(
          definition,
          input.policyAgentRef,
        )
      ) {
        return [];
      }
      const lifecycle = input.runtimeRegistry.resolveVoiceProviderRuntimeLifecycle?.(
        provider.identity,
      );
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

export function createAgentSessionRealtimeVoiceAuthority(input: Readonly<{
  occurrenceId: string;
  policyAgentRef: PluginContributionIdentityV1;
  isAgentRuntimeCurrent(): boolean;
  providers: readonly AgentSessionRealtimeVoicePolicyProvider[];
}>): AgentSessionRealtimeVoiceAuthority {
  const declarations = new Map<string, AgentSessionRealtimeVoicePolicyProvider>();
  for (const provider of input.providers) {
    if (
      isEligibleAgentSessionRealtimeVoiceDeclaration(
        provider.declaration,
        input.policyAgentRef,
      )
    ) {
      declarations.set(authorityKey(provider.provider), provider);
    }
  }

  return Object.freeze({
    occurrenceId: input.occurrenceId,
    policyAgentRef: input.policyAgentRef,
    isCurrent(provider) {
      const entry = declarations.get(authorityKey(provider));
      return Boolean(
        entry
        && !entry.retirementSignal.aborted
        && input.isAgentRuntimeCurrent()
        && entry.isCurrent(),
      );
    },
    resolveDeclaration(provider) {
      return declarations.get(authorityKey(provider))?.declaration ?? null;
    },
    resolveProviderOccurrenceId(provider) {
      return declarations.get(authorityKey(provider))?.occurrenceId ?? null;
    },
    resolveRetirementSignal(provider) {
      return declarations.get(authorityKey(provider))?.retirementSignal ?? null;
    },
    resolveConversation({ provider, runtime }) {
      const entry = declarations.get(authorityKey(provider));
      if (
        !entry
        || entry.retirementSignal.aborted
        || !input.isAgentRuntimeCurrent()
        || !entry.isCurrent()
      ) {
        return null;
      }
      try {
        // This is the host turn adapter, whose reader validates the native SDK
        // facet, follows replacement and withdraws on retirement.
        if (!runtime || typeof runtime !== 'object') return null;
        const hostRuntime = runtime as Pick<PluginRuntimeHookOperations, 'readAgentSessionRealtimeConversation'>;
        if (typeof hostRuntime.readAgentSessionRealtimeConversation !== 'function') return null;
        const conversation = hostRuntime.readAgentSessionRealtimeConversation();
        if (!conversation) return null;
        return Object.freeze({
          conversation,
          retirementSignal: entry.retirementSignal,
        });
      } catch {
        return null;
      }
    },
  });
}

export function resolveRetainedAgentSessionRealtimeVoiceAuthority(input: Readonly<{
  runtimeRegistry: VoiceAuthorityRuntimeRegistry | null;
  retainedAgent: unknown;
}>): AgentSessionRealtimeVoiceAuthority | null {
  const registry = input.runtimeRegistry;
  if (!registry) return null;

  let retainedAgent: ReturnType<typeof verifyAgentSessionRunnerBindingV1>;
  try {
    retainedAgent = verifyAgentSessionRunnerBindingV1(
      input.retainedAgent,
    );
  } catch {
    return null;
  }

  // Daemon callers re-attest this exact runner-carried G binding against its
  // immutable declaration. H becoming the registry Agent selects new Sessions
  // only, so it must not become G's lifecycle here. Retained-G hard revocation
  // remains owned by the daemon-service authority/transport; the current
  // registry is authoritative only for Voice-provider lifecycle below.
  return resolveAgentSessionRealtimeVoiceAuthority({
    runtimeRegistry: registry,
    policyAgentRef: {
      pluginId: retainedAgent.pluginId,
      localId: retainedAgent.localAgentId,
    },
    agentRuntimeIdentity: {
      pluginId: retainedAgent.pluginId,
      agentId: retainedAgent.agentId,
      localAgentId: retainedAgent.localAgentId,
      occurrenceId: JSON.stringify(retainedAgent.sourceCustody),
      sourceCustody: retainedAgent.sourceCustody,
      isCurrent: () => true,
    },
  });
}

export function resolveAgentSessionRealtimeVoiceAuthority(input: Readonly<{
  runtimeRegistry: VoiceAuthorityRuntimeRegistry | null;
  policyAgentRef: PluginContributionIdentityV1 | null;
  agentRuntimeIdentity: AgentRuntimeIdentity;
  agentRetirementSignal?: AbortSignal;
}>): AgentSessionRealtimeVoiceAuthority | null {
  const registry = input.runtimeRegistry;
  const policyAgentRef = input.policyAgentRef;
  const runtimePolicyAgentLocalId =
    input.agentRuntimeIdentity.localAgentId
    ?? input.agentRuntimeIdentity.agentId;
  if (
    !registry
    || !policyAgentRef
    || policyAgentRef.pluginId !== input.agentRuntimeIdentity.pluginId
    || policyAgentRef.localId !== runtimePolicyAgentLocalId
  ) {
    return null;
  }

  return createAgentSessionRealtimeVoiceAuthority({
    occurrenceId: input.agentRuntimeIdentity.occurrenceId,
    policyAgentRef,
    isAgentRuntimeCurrent: input.agentRuntimeIdentity.isCurrent,
    providers: snapshotAgentSessionRealtimeVoiceProviders({
      runtimeRegistry: registry,
      policyAgentRef,
    }).map(({ provider, lifecycle }) => {
      const retirementSignal = input.agentRetirementSignal
        ? AbortSignal.any([
            input.agentRetirementSignal,
            lifecycle.retirementSignal,
          ])
        : lifecycle.retirementSignal;
      return Object.freeze({
        provider: provider.identity,
        declaration: provider.definition,
        occurrenceId: lifecycle.occurrenceId,
        isCurrent: lifecycle.isCurrent,
        retirementSignal,
      });
    }),
  });
}
