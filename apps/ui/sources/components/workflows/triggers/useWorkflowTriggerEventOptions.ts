import * as React from 'react';
import { useEventCallback } from '@/hooks/ui/useEventCallback';

import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { acquireDaemonMergedWorkflowEventCatalog, readCachedDaemonMergedProjectionCacheEntry, readObservedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import type { WorkflowEventsListOutputV1 } from '@happier-dev/protocol/actions/specs/workflowEvents';
import {
  readEligibleEventPluginName,
  readEligibleEventPresentation,
} from '@/components/automations/editor/pluginEventAutomationEventPresentation';
import { readMissingPluginEventCatalogFailure } from '@/components/automations/editor/pluginEventAutomationObservationBinding';
import { arePluginContributionIdentitiesEqual } from '@/sync/domains/automations/pluginEventAutomationCurrentness';
import { HappyError } from '@/utils/errors/errors';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { PLUGIN_EVENT_AUTOMATION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';

import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import type { WorkflowTriggerEventOption } from './workflowTriggerStarts';

type EventCatalogFailure = Readonly<{ code: string; reason: string; details?: unknown }>;

const NO_EVENTS: readonly WorkflowTriggerEventOption[] = Object.freeze([]);

/**
 * The plugin-declared Events a trigger can start on, read from the Machine's trigger-event catalog
 * through workflow.events.list, named as the Event editor names them. Read only
 * while `enabled`: a closed menu with no plugin trigger issues no Machine read.
 */
export function useWorkflowTriggerEventOptions(
  params: Readonly<{
    machineId: string | null;
    serverId: string | null;
    enabled: boolean;
    accountLifetime?: ServerAccountScopeLifetime | null;
  }>,
): Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  events: readonly WorkflowTriggerEventOption[];
  readSelectedEvent(eventRef: WorkflowTriggerEventOption['eventRef']): Readonly<{
    option: WorkflowTriggerEventOption | null;
    failure: EventCatalogFailure | null;
  }>;
  retry(): void;
}> {
  const [refreshKey, setRefreshKey] = React.useState(0);
  const projection = useDaemonMergedProjectionInputs({
    machineId: params.machineId,
    accountLifetime: params.accountLifetime,
    serverId: params.serverId,
    enabled: params.enabled && params.machineId !== null,
    refreshKey,
    sections: PLUGIN_EVENT_AUTOMATION_SECTIONS,
  });
  const ready = projection.phase === 'ready' ? projection.inputs : null;
  const target = React.useMemo(() => params.enabled && projection.phase === 'ready'
    ? params.accountLifetime === undefined
      ? readCachedDaemonMergedProjectionCacheEntry({ machineId: params.machineId, serverId: params.serverId, sections: PLUGIN_EVENT_AUTOMATION_SECTIONS })
      : readObservedDaemonMergedProjectionCacheEntry({ machineId: params.machineId, serverId: params.serverId, accountLifetime: params.accountLifetime,
        sections: PLUGIN_EVENT_AUTOMATION_SECTIONS })
    : null,
  [params.enabled, params.machineId, params.serverId, params.accountLifetime, projection.phase, projection.inputs]);
  const [catalog, setCatalog] = React.useState<Readonly<{
    target: typeof target;
    status: 'ready' | 'unavailable';
    events: WorkflowEventsListOutputV1['events'];
    failure?: EventCatalogFailure;
  }> | null>(null);
  React.useEffect(() => {
    if (target?.kind !== 'ready' || !params.machineId) return;
    const read = acquireDaemonMergedWorkflowEventCatalog(target, params.machineId);
    let mounted = true;
    void read.promise.then(events => {
      if (mounted) setCatalog({ target, status: 'ready', events });
    }, (error: unknown) => {
      if (!mounted) return;
      const cause = error instanceof HappyError ? error.failureCause : undefined;
      const code = error instanceof HappyError ? error.code : undefined;
      const failure = code ? {
        code,
        reason: (cause && 'nativeErrorReason' in cause ? cause.nativeErrorReason : undefined) ?? cause?.errorCode ?? code,
        details: error instanceof HappyError ? error.details : undefined,
      } : undefined;
      setCatalog({ target, status: 'unavailable', events: [], failure });
    });
    return () => { mounted = false; read.release(); };
  }, [target, params.machineId, refreshKey]);
  const retry = useEventCallback(() => {
    if (!params.enabled || params.machineId === null) return;
    setCatalog(null);
    setRefreshKey(value => value + 1);
  });
  const admitted = catalog?.target === target ? catalog : null;
  const localize = usePluginLocalizedTextResolver({
    projection: ready?.pluginUiProjection ?? null,
  });
  const events = React.useMemo(() => {
    const eligible = admitted?.events;
    if (!eligible || eligible.length === 0) return NO_EVENTS;
    return eligible.map((entry) => ({
      eventRef: {
        pluginId: entry.event.identity.pluginId,
        localId: entry.event.identity.localId,
      },
      title: readEligibleEventPresentation(entry, localize).title,
      automation: entry.event.automation,
      payloadSchema: entry.event.payloadSchema,
      pluginName: readEligibleEventPluginName(
        ready,
        entry.event.identity.pluginId,
      ),
    }));
  }, [localize, ready, admitted]);
  const status =
    !params.enabled || params.machineId === null
      ? 'idle'
      : projection.phase === 'ready'
        ? admitted?.status ?? 'loading'
        : projection.phase === 'loading' || projection.phase === 'idle'
          ? 'loading'
          : 'unavailable';
  const readSelectedEvent = (eventRef: WorkflowTriggerEventOption['eventRef']) => {
    const option = events.find(event => arePluginContributionIdentitiesEqual(event.eventRef, eventRef)) ?? null;
    if (status === 'ready' && option === null) {
      return { option, failure: readMissingPluginEventCatalogFailure(ready?.pluginProjectionById[eventRef.pluginId]) };
    }
    const reason = projection.failureReason;
    const failure = status === 'unavailable' ? admitted?.failure ?? (reason ? { code: reason, reason } : null) : null;
    return { option, failure };
  };
  return { status, events, readSelectedEvent, retry };
}
