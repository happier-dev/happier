import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isHealthCheckEventSourceV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import type {
  SavedHealthCheckOptionV1,
  SavedHealthChecksListResultV1,
} from '@happier-dev/protocol/inputs/savedHealthCheckOptions';

import {
  readServiceCheckDefinitions,
  serviceCheckTitle,
} from '@/components/projects/deployments/serviceCheckPresentation';
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

/**
 * The saved Checks a person picks from (the Check widget's choices), named as the Checks list names them
 * ({@link serviceCheckTitle}). A Key flow says its routes beside its name. A Check whose definition cannot be opened
 * keeps its saved name, so it can still be picked.
 */
export function projectSavedServiceCheckOptions(
  automations: readonly AutomationDefinition[],
  access: PluginEventAutomationStoredContentAccess | null,
): readonly SavedHealthCheckOptionV1[] {
  return automations
    .flatMap((native) =>
      native.triggers.flatMap((trigger): SavedHealthCheckOptionV1[] => {
        if (
          !isPluginEventAutomationTrigger(trigger) ||
          !isHealthCheckEventSourceV1(trigger)
        )
          return [];
        const detail = access
          ? readPluginEventAutomationPrivateDetail(native, trigger.id, access)
          : null;
        const definition = detail
          ? (readServiceCheckDefinitions(detail.storedDefinition)?.[0] ?? null)
          : null;
        const named = serviceCheckTitle(definition, native.name);
        const description = definition?.keyFlow
          ? definition.targetLabel
          : named.title !== native.name
            ? native.name
            : null;
        return [
          {
            automationId: native.id,
            triggerId: trigger.id,
            label: named.title,
            ...(description ? { description } : {}),
          },
        ];
      }),
    )
    .sort((left, right) => left.label.localeCompare(right.label));
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
    return {
      items: projectSavedServiceCheckOptions(
        Object.values(storage.getState().automations),
        access,
      ),
    };
  } finally {
    release();
    retirement.dispose();
    signal?.removeEventListener('abort', abort);
  }
}
