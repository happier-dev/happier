import * as React from 'react';
import type { PluginProjectedComposerControlEntryV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import type { CrossSessionAuthoringControlTarget } from '@/components/sessions/authoring/controls/crossSessionAuthoringFieldControls';
import {
  resolveSessionAuthoringAgentId,
  type SessionAuthoringControlFacts,
} from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { useSessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/useSessionAuthoringControlFacts';
import { useSessionAuthoringControls } from '@/components/sessions/authoring/controls/useSessionAuthoringControls';
import type { BulkSessionAuthoringFact } from '@/sync/store/bulkSessionAuthoringFacts';
import { COMPOSER_HOST_PROJECTION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { retainShallow } from '@/sync/domains/state/structuralSharing';

/** What one Machine contributes: its authoring facts (Agent catalog) and its admitted plugin Composer controls. */
type MachineResolution = Readonly<{
  facts: SessionAuthoringControlFacts;
  pluginProjection: PluginUiProjectionModel | null;
  pluginControls: readonly PluginProjectedComposerControlEntryV1[];
}>;

export type BulkSessionControlTargets = Readonly<{
  /** Every ready target's own controls, in target order; null until each has resolved. */
  targets: readonly CrossSessionAuthoringControlTarget[] | null;
  /** The first Machine's facts: the engine picker's catalog context (its rows are narrowed to the intersection). */
  leadFacts: SessionAuthoringControlFacts | null;
  pluginProjection: PluginUiProjectionModel | null;
  /** Plugin Composer controls admitted on any target's Machine, once each. */
  pluginControls: readonly PluginProjectedComposerControlEntryV1[];
  /** Mount once: the probes run the canonical per-Session hooks and render nothing. */
  probes: React.ReactNode;
}>;

const NO_PLUGIN_CONTROLS: readonly PluginProjectedComposerControlEntryV1[] =
  Object.freeze([]);

/**
 * The cross-session chips need each target's controls from the canonical per-Session owners
 * (`useSessionAuthoringControlFacts` per Machine, `useSessionAuthoringControls` per Session). Hooks cannot run
 * in a loop, so one probe per Machine and one per Session runs them and reports the settled results here.
 * Inputs are the content-stable bulk facts, so a target streaming its transcript reports nothing new.
 */
export function useBulkSessionControlTargets(
  facts: readonly BulkSessionAuthoringFact[],
): BulkSessionControlTargets {
  const ready = React.useMemo(
    () => facts.filter((fact) => fact.status === 'ready' && fact.machineId),
    [facts],
  );
  const [targetsByKey, setTargetsByKey] = React.useState<
    ReadonlyMap<string, CrossSessionAuthoringControlTarget>
  >(() => new Map());
  const [machinesByKey, setMachinesByKey] = React.useState<
    ReadonlyMap<string, MachineResolution>
  >(() => new Map());
  const reportTarget = useEventCallback(
    (key: string, value: CrossSessionAuthoringControlTarget | null) => {
      setTargetsByKey((previous) => replaceEntry(previous, key, value));
    },
  );
  const reportMachine = useEventCallback(
    (key: string, value: MachineResolution | null) => {
      setMachinesByKey((previous) => replaceEntry(previous, key, value));
    },
  );

  const machineGroups = React.useMemo(() => {
    const groups = new Map<
      string,
      { serverId: string; machineId: string; facts: BulkSessionAuthoringFact[] }
    >();
    for (const fact of ready) {
      const key = machineKey(fact.address.serverId, fact.machineId!);
      const group = groups.get(key) ?? {
        serverId: fact.address.serverId,
        machineId: fact.machineId!,
        facts: [],
      };
      group.facts.push(fact);
      groups.set(key, group);
    }
    return [...groups.entries()];
  }, [ready]);

  const publishedTargets = React.useRef<readonly CrossSessionAuthoringControlTarget[] | undefined>(undefined);
  const targets = React.useMemo(() => {
    const resolved = ready.map((fact) =>
      targetsByKey.get(sessionAddressKey(fact.address)),
    );
    if (!resolved.every(
      (target): target is CrossSessionAuthoringControlTarget =>
        target !== undefined,
    )) return null;

    // A Session fact can change before its probe reports newly resolved controls.
    // Keep the intersection input stable while the ordered reports are unchanged.
    const retained = retainShallow(publishedTargets.current, resolved);
    publishedTargets.current = retained;
    return retained;
  }, [ready, targetsByKey]);
  const leadFacts =
    machineGroups.length > 0
      ? (machinesByKey.get(machineGroups[0]![0])?.facts ?? null)
      : null;
  const pluginProjection =
    machineGroups.length > 0
      ? (machinesByKey.get(machineGroups[0]![0])?.pluginProjection ?? null)
      : null;
  const pluginControls = React.useMemo(() => {
    const byId = new Map<string, PluginProjectedComposerControlEntryV1>();
    for (const [key] of machineGroups) {
      for (const control of machinesByKey.get(key)?.pluginControls ?? []) {
        if (!byId.has(control.id)) byId.set(control.id, control);
      }
    }
    return byId.size > 0 ? [...byId.values()] : NO_PLUGIN_CONTROLS;
  }, [machineGroups, machinesByKey]);

  const probes = machineGroups.map(([key, group]) => (
    <MachineProbe
      key={key}
      machineKeyValue={key}
      serverId={group.serverId}
      machineId={group.machineId}
      facts={group.facts}
      reportMachine={reportMachine}
      reportTarget={reportTarget}
    />
  ));
  return { targets, leadFacts, pluginProjection, pluginControls, probes };
}

function MachineProbe(
  props: Readonly<{
    machineKeyValue: string;
    serverId: string;
    machineId: string;
    facts: readonly BulkSessionAuthoringFact[];
    reportMachine: (key: string, value: MachineResolution | null) => void;
    reportTarget: (
      key: string,
      value: CrossSessionAuthoringControlTarget | null,
    ) => void;
  }>,
) {
  const { machineKeyValue, reportMachine } = props;
  const facts = useSessionAuthoringControlFacts({
    machineId: props.machineId,
    serverId: props.serverId,
  });
  const projection = useDaemonMergedProjectionInputs({
    sections: COMPOSER_HOST_PROJECTION_SECTIONS,
    machineId: props.machineId,
    serverId: props.serverId,
  });
  const pluginProjection = projection.inputs?.pluginUiProjection ?? null;
  const controlsById = pluginProjection?.composerControlsById;
  const pluginControls = React.useMemo(
    () => (controlsById ? Object.values(controlsById) : NO_PLUGIN_CONTROLS),
    [controlsById],
  );
  React.useEffect(() => {
    reportMachine(machineKeyValue, { facts, pluginProjection, pluginControls });
  }, [facts, machineKeyValue, pluginControls, pluginProjection, reportMachine]);
  React.useEffect(
    () => () => reportMachine(machineKeyValue, null),
    [machineKeyValue, reportMachine],
  );
  return (
    <>
      {props.facts.map((fact) => (
        <TargetProbe
          key={sessionAddressKey(fact.address)}
          fact={fact}
          machineFacts={facts}
          reportTarget={props.reportTarget}
        />
      ))}
    </>
  );
}

function TargetProbe(
  props: Readonly<{
    fact: BulkSessionAuthoringFact;
    machineFacts: SessionAuthoringControlFacts;
    reportTarget: (
      key: string,
      value: CrossSessionAuthoringControlTarget | null,
    ) => void;
  }>,
) {
  const { fact, machineFacts, reportTarget } = props;
  const key = sessionAddressKey(fact.address);
  const agentId = resolveSessionAuthoringAgentId({
    agentTarget: fact.agentTarget,
    facts: machineFacts,
  });
  const resolvedControls = useSessionAuthoringControls({
    agentId: agentId ?? fact.agentId ?? '',
    permissionMode: isPermissionMode(fact.permissionMode)
      ? fact.permissionMode
      : null,
    modelMode: fact.modelId,
    canChangeModel: true,
    canChangeSessionMode: true,
    canChangeConfigOption: true,
    acpConfigOptionOverridesOverride: fact.sessionConfigOptionOverrides,
  });
  // The policy hook returns a fresh bundle of individually memoized members on every render; keep the
  // previous bundle while its members are unchanged, or reporting it upward would loop.
  const controlsRef = React.useRef<typeof resolvedControls | undefined>(undefined);
  const controls = retainShallow(controlsRef.current, resolvedControls);
  controlsRef.current = controls;
  React.useEffect(() => {
    reportTarget(key, {
      agentId,
      values: fact.values,
      controls,
      facts: machineFacts,
    });
  }, [agentId, controls, fact.values, key, machineFacts, reportTarget]);
  React.useEffect(() => () => reportTarget(key, null), [key, reportTarget]);
  return null;
}

function machineKey(serverId: string, machineId: string): string {
  return JSON.stringify([serverId, machineId]);
}

function replaceEntry<T>(
  previous: ReadonlyMap<string, T>,
  key: string,
  value: T | null,
): ReadonlyMap<string, T> {
  if (value === null) {
    if (!previous.has(key)) return previous;
    const next = new Map(previous);
    next.delete(key);
    return next;
  }
  if (previous.get(key) === value) return previous;
  return new Map(previous).set(key, value);
}
