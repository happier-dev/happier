import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { ProviderModelDescriptorV1Schema } from '@happier-dev/protocol/models/descriptor';
import type { ProviderBoundModelRef, ProviderModelDescriptorV1 } from '@happier-dev/protocol';
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
import { readProviderSettingsForCli } from '../settings/read';
import { resolveSpawnConnectedServicesDefaultDisposition } from '@/session/services/spawnConnectedServicesDefaults';
import { resolveAgentManagedPurposeSelections, resolveManagedPurposeModelSelectionRejection } from '../managed/agentPurposeSelections';

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
  sourceModel?: ProviderModelDescriptorV1;
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
  if (input.sourceModel !== undefined) {
    const sourceModel = ProviderModelDescriptorV1Schema.safeParse(input.sourceModel);
    return { ok: sourceModel.success && sourceModel.data.id === modelId };
  }
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
  if (modelId === undefined && providerConnectionId != null) return { ok: false };

  const parsed = modelId === undefined ? null : ProviderBoundModelRefSchema.safeParse({
    agentTargetKey: input.agentTargetKey,
    providerConnectionId: providerConnectionId ?? null,
    modelId,
  });
  if (parsed && !parsed.success) return { ok: false };
  const ref = parsed?.success ? parsed.data : null;

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
    if (!snapshot || !lease) return { ok: true, ref };
    if (ref === null) {
      // Only an already-published purpose catalog can establish a missing
      // managed model here. Cold projections remain the launch owner's work.
      if (snapshot.connectedPurposeCatalog?.status !== 'ready') return { ok: true, ref };
      const disposition = resolveSpawnConnectedServicesDefaultDisposition({ agentId: input.agentId,
        accountSettings: snapshot.settings, contributions: lease.registry.contributes,
        catalogEntry: lease.registry.contributes.catalogEntriesById[input.agentId] ?? null,
        purposeCatalog: snapshot.connectedPurposeCatalog });
      if (disposition.kind !== 'connected') return { ok: true, ref };
      const candidates = resolveAgentManagedPurposeSelections({ agentId: input.agentId,
        contributions: lease.registry.contributes, connectedServices: disposition.bindings });
      return resolveManagedPurposeModelSelectionRejection({ candidates }) ? { ok: false } : { ok: true, ref };
    }
    const definitive = resolveProviderSpawnDefinitiveRejection({
      selection: ref,
      agentTargetKey: input.agentTargetKey,
      agentId: input.agentId,
      providerSettings: readProviderSettingsForCli(snapshot).settings,
      registry: lease.registry.contributes,
    });
    return definitive.ok ? { ok: true, ref } : { ok: false };
  } catch {
    // A malformed or replaced projection is not locally definitive.  Preserve
    // the launch owner's dynamic error path instead of inventing a readiness
    // cache or a second failure authority here.
    return { ok: true, ref };
  } finally {
    if (lease) await lease.release().catch(() => undefined);
  }
}
