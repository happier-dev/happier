import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isHealthCheckEventSourceV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import { workflowTriggerDisplayNameV1 } from '@happier-dev/protocol/workflows/workflowStepLabel';
import type {
  SavedHealthCheckOptionV1,
  SavedHealthChecksListResultV1,
} from '@happier-dev/protocol/inputs/savedHealthCheckOptions';

import {
  readServiceCheckDefinitions,
  serviceCheckTitle,
  type ServiceCheckDefinitionFacts,
} from '@/components/projects/deployments/serviceCheckPresentation';
import { createDeploymentReadTransport } from '@/components/projects/deployments/deploymentReadTransport';
import { retainAutomationDefinitionDetailsDemand } from '@/sync/domains/automations/automationReadDemand';
import {
  isPluginEventAutomationTrigger,
  type AutomationDefinition,
} from '@/sync/domains/automations/automationTypes';
import {
  readPluginEventAutomationPrivateDetail,
  type PluginEventAutomationStoredContentAccess,
} from '@/sync/domains/automations/pluginEventAutomationEditSeed';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';

import { openConfiguredCheckContentAccess } from './useConfiguredCheckDefinitions';

type SavedServiceCheck = Readonly<{
  automationId: string;
  triggerId: string;
  sourceInstanceId?: string;
  automationName: string;
  savedName?: string;
  definition: ServiceCheckDefinitionFacts | null;
}>;

function readSavedServiceChecks(
  automations: readonly AutomationDefinition[],
  access: PluginEventAutomationStoredContentAccess | null,
): readonly SavedServiceCheck[] {
  return automations.flatMap(native =>
    native.triggers.flatMap((trigger): SavedServiceCheck[] => {
      if (!isPluginEventAutomationTrigger(trigger) || !isHealthCheckEventSourceV1(trigger)) return [];
      const detail = access ? readPluginEventAutomationPrivateDetail(native, trigger.id, access) : null;
      const definitions = detail ? readServiceCheckDefinitions(detail.storedDefinition) : null;
      if (definitions?.length === 0) return [];
      return [{
        automationId: native.id,
        triggerId: trigger.id,
        ...(detail ? { sourceInstanceId: detail.storedDefinition.sourceInstanceId } : {}),
        automationName: native.name,
        savedName: workflowTriggerDisplayNameV1(native),
        definition: definitions?.[0] ?? null,
      }];
    }),
  );
}

/** A Check whose private definition cannot be opened keeps its saved name. */
function presentSavedServiceCheckOptions(
  checks: readonly SavedServiceCheck[],
  environmentNames?: ReadonlyMap<string, string>,
): readonly SavedHealthCheckOptionV1[] {
  return checks.map(({ automationName, savedName, definition, ...identity }) => {
    const { title } = serviceCheckTitle(definition, environmentNames, automationName);
    const description = definition?.targetLabel && title !== definition.targetLabel
      ? definition.targetLabel : title !== savedName ? savedName : null;
    return { ...identity, label: title, ...(description ? { description } : {}) };
  }).sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Every page of the active Account's saved Checks, read the way the Checks list reads them (the private Automation page
 * under definition demand, then the Account's material), held only for this read.
 */
export async function listSavedServiceCheckOptions(
  args: Readonly<{ serverId: string }>,
  signal: AbortSignal | undefined,
): Promise<SavedHealthChecksListResultV1 | ActionExecuteFailure> {
  const lifetime = captureActiveServerAccountScopeLifetime();
  if (
    !lifetime ||
    !areServerProfileIdentifiersEquivalent(
      lifetime.scope.serverId,
      args.serverId,
    )
  ) {
    return {
      ok: false,
      errorCode: 'server_scope_mismatch',
      error: 'server_scope_mismatch',
    };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  const retirement = lifetime.onRetire(abort);
  const release = retainAutomationDefinitionDetailsDemand(lifetime);
  try {
    const { sync } = await import('@/sync/sync');
    await sync.ensureAutomationsRead();
    let cursor = storage.getState().automationDefinitionNextCursor;
    while (cursor) {
      controller.signal.throwIfAborted();
      cursor = (await sync.loadMoreAutomations(cursor)).nextCursor;
    }
    const access = await openConfiguredCheckContentAccess(
      lifetime,
      controller.signal,
    );
    controller.signal.throwIfAborted();
    if (!lifetime.isCurrent())
      return {
        ok: false,
        errorCode: 'server_scope_mismatch',
        error: 'server_scope_mismatch',
      };
    const checks = readSavedServiceChecks(Object.values(storage.getState().automations), access);
    const environmentIds = [...new Set(checks.flatMap(({ definition }) =>
      definition?.titleTarget?.kind === 'environment' ? [definition.titleTarget.id] : []))];
    const environmentPage = environmentIds.length > 0
      ? await createDeploymentReadTransport(lifetime).listEnvironments(lifetime.scope,
        { environmentIds, allPages: true }, { signal: controller.signal }) : null;
    controller.signal.throwIfAborted();
    const environmentNames = environmentPage?.ok
      ? new Map(environmentPage.value.items.map(row => [row.environment.id, row.title])) : undefined;
    return { items: presentSavedServiceCheckOptions(checks, environmentNames) };
  } finally {
    release();
    retirement.dispose();
    signal?.removeEventListener('abort', abort);
  }
}
