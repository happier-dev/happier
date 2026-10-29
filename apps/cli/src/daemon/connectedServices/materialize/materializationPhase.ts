import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { QualifiedConnectedAccountServiceRef } from '@happier-dev/protocol';

import { logger } from '@/utils/logger';

type MaterializationPhase =
  | 'credential_binding_resolution'
  | 'group_state_read'
  | 'group_lease_wait'
  | 'group_generation_apply'
  | 'group_quota_probe'
  | 'credential_read'
  | 'credential_refresh'
  | 'refresh_reconnect_inventory'
  | 'refresh_status_invocation'
  | 'refresh_health_settlement'
  | 'purpose_activation'
  | 'run_root_queue'
  | 'run_materialization'
  | 'materialization_root_prepare'
  | 'materialization_root_finalize'
  | 'artifact_currentness_before'
  | 'artifact_currentness_after'
  | 'plugin_registry'
  | 'binding_read'
  | 'launch_credentials'
  | 'native_home_queue'
  | 'native_home_prepare'
  | 'native_home_state'
  | 'native_home_import'
  | 'native_home_manifest'
  | 'native_home_credentials'
  | 'materialization_binding_before'
  | 'materialization_invoke'
  | 'materialization_binding_after'
  | 'established_account_currentness'
  | 'established_credential_read'
  | 'established_configuration_read'
  | 'established_account_mode'
  | 'established_snapshots'
  | 'established_registry'
  | 'established_runtime_resolution'
  | 'established_configuration_record'
  | 'established_configuration'
  | 'established_registry_release'
  | 'established_runtime'
  | 'runtime_registry'
  | 'runtime_configuration_currentness'
  | 'runtime_credential_currentness'
  | 'runtime_callback_before'
  | 'runtime_callback'
  | 'runtime_callback_after'
  | 'native_home_credential_write'
  | 'materialization_promotion';

type MaterializationContext = Readonly<{
  agentId: string;
  materializationKey: string;
  service?: QualifiedConnectedAccountServiceRef;
}>;

// Diagnostic correlation only: no authority or credential material crosses this scope.
const activePhase = new AsyncLocalStorage<Readonly<{
  context: MaterializationContext;
  phaseId: string;
}>>();

/** File-only, allowlisted diagnostics: never include roots, credentials or exception contents. */
function createPhase(
  context: MaterializationContext,
  phase: MaterializationPhase,
) {
  const phaseId = randomUUID();
  const parent = activePhase.getStore();
  const parentPhaseId = parent?.context.agentId === context.agentId
    && parent.context.materializationKey === context.materializationKey ? parent.phaseId : undefined;
  const startedAt = performance.now();
  const log = (status: 'started' | 'completed' | 'failed') => logger.infoFile('[CONNECTED ACCOUNT] Materialization phase', {
    agentId: context.agentId,
    materializationKey: context.materializationKey,
    ...(context.service ? { service: {
      pluginId: context.service.pluginId,
      localId: context.service.localId,
    } } : {}),
    phase,
    phaseId,
    ...(parentPhaseId ? { parentPhaseId } : {}),
    status,
    durationMs: status === 'started' ? 0 : Math.round(performance.now() - startedAt),
  });
  log('started');
  return { phaseId, finish: (status: 'completed' | 'failed') => log(status) };
}

export function startConnectedServiceMaterializationPhase(
  context: MaterializationContext,
  phase: MaterializationPhase,
): (status: 'completed' | 'failed') => void {
  return createPhase(context, phase).finish;
}

export async function observeConnectedServiceMaterializationPhase<T>(
  context: MaterializationContext,
  phase: MaterializationPhase,
  work: () => Promise<T>,
): Promise<T> {
  const { phaseId, finish } = createPhase(context, phase);
  try {
    const result = await activePhase.run({ context, phaseId }, work);
    finish('completed');
    return result;
  } catch (error) {
    finish('failed');
    throw error;
  }
}

/** Host-private inner spans are emitted only inside an observed materialization. */
export async function observeCurrentConnectedServiceMaterializationPhase<T>(
  phase: MaterializationPhase,
  work: () => T | Promise<T>,
): Promise<T> {
  const current = activePhase.getStore();
  return current
    ? observeConnectedServiceMaterializationPhase(current.context, phase, async () => work())
    : work();
}
