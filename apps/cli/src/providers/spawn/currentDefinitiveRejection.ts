import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { SessionModelRefSchema, projectSessionModelRefToExecutionModelSelection, type SessionModelRef } from '@happier-dev/protocol/providers/selection/v2';
import { ProviderModelDescriptorV1Schema } from '@happier-dev/protocol/models/descriptor';
import type { ProviderModelDescriptorV1 } from '@happier-dev/protocol';
import type { SessionSpawnLaunchErrorV1 } from '@happier-dev/protocol/spawnSession';
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

export type ProviderLaunchSelectionInput = Readonly<{
  modelSelection?: SessionModelRef;
  modelId?: unknown;
  providerConnectionId?: unknown;
  acpSessionModeId?: unknown;
  sessionConfigOptionOverrides?: unknown;
}>;

export type CurrentProviderSpawnDefinitiveRejectionResult =
  | Readonly<{ ok: true; ref: SessionModelRef | null }>
  | Readonly<{ ok: false }>;

type CurrentProviderSpawnDefinitiveRejectionDeps = Readonly<{
  getActiveAccountSettingsSnapshot: typeof getActiveAccountSettingsSnapshot;
  tryAcquireAuthoritativePluginRuntimeRegistryLease:
    typeof tryAcquireAuthoritativePluginRuntimeRegistryLease;
}>;

export type AgentNativeSpawnDefinitiveRejectionResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; launchError: SessionSpawnLaunchErrorV1 }>;

function rejectNativeSelection(
  reason: 'model_not_selectable' | 'session_mode_not_selectable' | 'session_config_invalid',
): Extract<AgentNativeSpawnDefinitiveRejectionResult, { ok: false }> {
  const model = reason === 'model_not_selectable';
  const code = model ? 'agent_startup_model_reconciliation_failed' : 'agent_startup_invalid_state';
  const message = model
    ? 'Choose a model offered by this Agent, or enter an explicit model ID when its model selector allows it.'
    : reason === 'session_mode_not_selectable'
      ? 'Choose a session mode supported by this Agent, or clear the selected mode.'
      : 'Clear the invalid session configuration overrides and choose the options again.';
  return { ok: false, launchError: { kind: 'launch_error', code, message,
    failureCause: { code, phase: 'client_start', retryable: false,
      failureReason: model ? 'model_selection_invalid' : 'session_configuration_invalid',
      providerErrorCode: reason } } };
}

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
    return rejectNativeSelection('session_config_invalid');
  }

  const acpSessionModeId = input.selection.acpSessionModeId;
  if (
    acpSessionModeId != null
    && (typeof acpSessionModeId !== 'string' || acpSessionModeId.trim().length === 0)
  ) {
    return rejectNativeSelection('session_mode_not_selectable');
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
    return rejectNativeSelection('session_mode_not_selectable');
  }

  const modelId = input.selection.modelId;
  if (input.sourceModel !== undefined) {
    const sourceModel = ProviderModelDescriptorV1Schema.safeParse(input.sourceModel);
    return sourceModel.success && sourceModel.data.id === modelId
      ? { ok: true } : rejectNativeSelection('model_not_selectable');
  }
  if (modelId === undefined || modelId === 'default') return { ok: true };
  if (typeof modelId !== 'string' || modelId.trim().length === 0) return rejectNativeSelection('model_not_selectable');

  const modelConfig = getAgentModelConfig(input.agentId);
  if (modelConfig == null) return { ok: true };
  if (modelConfig.supportsSelection !== true) return rejectNativeSelection('model_not_selectable');
  if (getAgentStaticModels(input.agentId).some((model) =>
    model.id === modelId || model.extendedContextModelId === modelId,
  )) {
    return { ok: true };
  }
  if (modelConfig.dynamicProbe !== 'static-only') return { ok: true };
  return isFreeformModelIdAllowed(modelConfig, modelId) ? { ok: true } : rejectNativeSelection('model_not_selectable');
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
  const authoredRef = input.selection.modelSelection;
  const projected = authoredRef ? projectSessionModelRefToExecutionModelSelection(authoredRef) : undefined;
  const selection = projected?.modelSelection ? { ...input.selection, ...projected.modelSelection } : input.selection;
  const native = resolveAgentNativeSpawnDefinitiveRejection({
    agentId: projected?.teamCredentialModel ? null : input.agentId,
    selection,
  });
  if (!native.ok) return { ok: false };
  if (projected?.teamCredentialModel && authoredRef) return { ok: true, ref: authoredRef };

  const modelId = selection.modelId;
  const providerConnectionId = selection.providerConnectionId;
  if (modelId === undefined) {
    return providerConnectionId === undefined || providerConnectionId === null
      ? { ok: true, ref: null }
      : { ok: false };
  }

  const parsed = SessionModelRefSchema.safeParse(authoredRef ?? {
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
      providerSettings: readProviderSettingsForCli(snapshot).settings,
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
