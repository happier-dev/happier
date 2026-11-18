import * as React from 'react';

import { useCorePageWidgetAreaBinding } from '@/components/widgets/area/useCorePageWidgetAreaBinding';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';

import {
  createMachinesWidgetPresets,
  type MachinesWidgetPresetMachine,
  type MachinesWidgetPresetNames,
} from './machinesWidgetPresets';

/** All machines provides no page value: every machine widget there names its own machine (or follows its group). */
const MACHINES_PAGE_CONTEXT: WidgetSurfaceContext = Object.freeze({});

/**
 * The All machines dashboard area (AGW-19): a core-page area `machines` / `main` through the platform's one
 * core-page binding (named views, revisions, Reset/Undo stay platform-owned). The preset's machine is pinned
 * once, after the preset selector offers an online machine or a fallback from the loaded fleet — never recomputed from live state while
 * the person looks (D5). Loading/fallback eligibility belongs to that selector, not a second rule here.
 */
export function useMachinesWidgetAreaBinding(
  input: Readonly<{
    serverId: string;
    names: MachinesWidgetPresetNames;
    /** The machine that needs the person now, else this computer, else the first online machine. */
    pinnedMachine: MachinesWidgetPresetMachine | null;
  }>,
): { -readonly [K in keyof ReturnType<typeof useCorePageWidgetAreaBinding>]: ReturnType<typeof useCorePageWidgetAreaBinding>[K] } & {
  presets: ReturnType<typeof createMachinesWidgetPresets>;
} {
  const pinned = React.useRef<MachinesWidgetPresetMachine | null>(null);
  if (!pinned.current && input.pinnedMachine)
    pinned.current = input.pinnedMachine;
  const machineKey = pinned.current
    ? `${pinned.current.serverId}\u0000${pinned.current.machineId}`
    : null;
  const presets = React.useMemo(
    () => createMachinesWidgetPresets(input.names, { machine: pinned.current }),
    [input.names, machineKey],
  );
  const binding = useCorePageWidgetAreaBinding({
    serverId: input.serverId,
    pageId: 'machines',
    area: 'main',
    presets,
    context: MACHINES_PAGE_CONTEXT,
  });
  return React.useMemo(() => ({ ...binding, presets }), [binding, presets]);
}
