import * as React from 'react';

import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import {
  readEligibleEventPluginName,
  readEligibleEventPresentation,
} from '@/components/automations/editor/pluginEventAutomationEventPresentation';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { PLUGIN_EVENT_AUTOMATION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';

import type { WorkflowTriggerEventOption } from './workflowTriggerStarts';

const NO_EVENTS: readonly WorkflowTriggerEventOption[] = Object.freeze([]);

/**
 * The plugin-declared Events a trigger can start on, read from the Machine's trigger-event catalog
 * (the merged daemon projection the Event editor reads), named as that editor names them. Read only
 * while `enabled`: a closed menu with no plugin trigger issues no Machine read.
 */
export function useWorkflowTriggerEventOptions(
  params: Readonly<{
    machineId: string | null;
    serverId: string | null;
    enabled: boolean;
  }>,
): Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  events: readonly WorkflowTriggerEventOption[];
}> {
  const projection = useDaemonMergedProjectionInputs({
    machineId: params.machineId,
    serverId: params.serverId,
    enabled: params.enabled && params.machineId !== null,
    sections: PLUGIN_EVENT_AUTOMATION_SECTIONS,
  });
  const ready = projection.phase === 'ready' ? projection.inputs : null;
  const localize = usePluginLocalizedTextResolver({
    projection: ready?.pluginUiProjection ?? null,
  });
  const events = React.useMemo(() => {
    const eligible = ready?.automationEligibleEvents;
    if (!eligible || eligible.length === 0) return NO_EVENTS;
    return eligible.map((entry) => ({
      eventRef: {
        pluginId: entry.event.identity.pluginId,
        localId: entry.event.identity.localId,
      },
      title: readEligibleEventPresentation(entry, localize).title,
      pluginName: readEligibleEventPluginName(
        ready,
        entry.event.identity.pluginId,
      ),
    }));
  }, [localize, ready]);
  const status =
    !params.enabled || params.machineId === null
      ? 'idle'
      : projection.phase === 'ready'
        ? 'ready'
        : projection.phase === 'loading' || projection.phase === 'idle'
          ? 'loading'
          : 'unavailable';
  return { status, events };
}
