import {
  AcpConfigOptionOverridesV1Schema,
  ProviderBoundModelRefSchema,
  type ProviderBoundModelRef,
} from '@happier-dev/protocol';
import {
  getAgentModelConfig,
  getAgentSessionModeDescriptor,
  getAgentStaticModels,
  isFreeformModelIdAllowed,
  type AgentId,
} from '@happier-dev/agents';

import {
  getActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
  tryAcquireAuthoritativePluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';

import { resolveProviderSpawnDefinitiveRejection } from './resolve';

export type ProviderLaunchSelectionInput = Readonly<{
  modelId?: unknown;
  providerConnectionId?: unknown;
  acpSessionModeId?: unknown;
  sessionConfigOptionOverrides?: unknown;
}>;

export type CurrentProviderSpawnDefinitiveRejectionResult =
  | Readonly<{ ok: true; ref: ProviderBoundModelRef | null }>
  | Readonly<{ ok: false }>;

type CurrentProviderSpawnDefinitiveRejectionDeps = Readonly<{
  getActiveAccountSettingsSnapshot: typeof getActiveAccountSettingsSnapshot;
  tryAcquireAuthoritativePluginRuntimeRegistryLease:
    typeof tryAcquireAuthoritativePluginRuntimeRegistryLease;
}>;

export type AgentNativeSpawnDefinitiveRejectionResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false }>;

/**
 * The side-effect-free native half of spawn authorization. It rejects only
 * static catalog facts that the ordinary launch owner already owns; dynamic
 * provider, ACP, and runtime facts deliberately remain for that owner.
 */
export function resolveAgentNativeSpawnDefinitiveRejection(input: Readonly<{
  agentId: AgentId | null;
  selection: ProviderLaunchSelectionInput;
}>): AgentNativeSpawnDefinitiveRejectionResult {
  const sessionConfigOptionOverrides = input.selection.sessionConfigOptionOverrides;
  if (
    sessionConfigOptionOverrides !== undefined
    && !AcpConfigOptionOverridesV1Schema.safeParse(sessionConfigOptionOverrides).success
  ) {
    return { ok: false };
  }

  const acpSessionModeId = input.selection.acpSessionModeId;
  if (
    acpSessionModeId != null
    && (typeof acpSessionModeId !== 'string' || acpSessionModeId.trim().length === 0)
  ) {
    return { ok: false };
  }

  // Provider-bound models are validated by the existing Provider catalog
  // authority below. Native static facts must not override that catalog.
  if (input.selection.providerConnectionId != null || input.agentId === null) {
    return { ok: true };
  }

  const sessionModeDescriptor = getAgentSessionModeDescriptor(input.agentId);
  if (
    acpSessionModeId != null
    && sessionModeDescriptor != null
    && (sessionModeDescriptor.source === 'none' || sessionModeDescriptor.semantics === 'none')
  ) {
    return { ok: false };
  }

  const modelId = input.selection.modelId;
  if (modelId === undefined || modelId === 'default') return { ok: true };
  if (typeof modelId !== 'string' || modelId.trim().length === 0) return { ok: false };

  const modelConfig = getAgentModelConfig(input.agentId);
  if (modelConfig == null) return { ok: true };
  if (modelConfig.supportsSelection !== true) return { ok: false };
  if (getAgentStaticModels(input.agentId).some((model) =>
    model.id === modelId || model.extendedContextModelId === modelId,
  )) {
    return { ok: true };
  }
  if (modelConfig.dynamicProbe !== 'static-only') return { ok: true };
  return isFreeformModelIdAllowed(modelConfig, modelId) ? { ok: true } : { ok: false };
}

/**
 * Adapts a Session-facing selection to the provider spawn owner's cold,
 * definitive-rejection phase.  This is intentionally a read-only observation:
 * unavailable Account or plugin projections leave the target eligible and the
 * ordinary launch owner reports any later dynamic failure.
 */
export async function resolveCurrentProviderSpawnDefinitiveRejection(input: Readonly<{
  agentTargetKey: string;
  agentId: AgentId;
  selection: ProviderLaunchSelectionInput;
  deps?: Partial<CurrentProviderSpawnDefinitiveRejectionDeps>;
}>): Promise<CurrentProviderSpawnDefinitiveRejectionResult> {
  const native = resolveAgentNativeSpawnDefinitiveRejection({
    agentId: input.agentId,
    selection: input.selection,
  });
  if (!native.ok) return native;

  const modelId = input.selection.modelId;
  const providerConnectionId = input.selection.providerConnectionId;
  if (modelId === undefined) {
    return providerConnectionId === undefined || providerConnectionId === null
      ? { ok: true, ref: null }
      : { ok: false };
  }

  const parsed = ProviderBoundModelRefSchema.safeParse({
    agentTargetKey: input.agentTargetKey,
    providerConnectionId: providerConnectionId ?? null,
    modelId,
  });
  if (!parsed.success) return { ok: false };

  const deps: CurrentProviderSpawnDefinitiveRejectionDeps = {
    getActiveAccountSettingsSnapshot,
    tryAcquireAuthoritativePluginRuntimeRegistryLease,
    ...input.deps,
  };
  let lease: ReturnType<
    CurrentProviderSpawnDefinitiveRejectionDeps['tryAcquireAuthoritativePluginRuntimeRegistryLease']
  > = null;
  try {
    const snapshot = deps.getActiveAccountSettingsSnapshot();
    lease = deps.tryAcquireAuthoritativePluginRuntimeRegistryLease();
    if (!snapshot || !lease) return { ok: true, ref: parsed.data };
    const definitive = resolveProviderSpawnDefinitiveRejection({
      selection: parsed.data,
      agentTargetKey: input.agentTargetKey,
      agentId: input.agentId,
      accountSettings: snapshot.settings,
      registry: lease.registry.contributes,
    });
    return definitive.ok ? { ok: true, ref: parsed.data } : { ok: false };
  } catch {
    // A malformed or replaced projection is not locally definitive.  Preserve
    // the launch owner's dynamic error path instead of inventing a readiness
    // cache or a second failure authority here.
    return { ok: true, ref: parsed.data };
  } finally {
    if (lease) await lease.release().catch(() => undefined);
  }
}
