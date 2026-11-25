import * as React from 'react';

import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { WidgetArea } from '@/components/widgets/area/WidgetArea';
import { WidgetAreaPresetLine } from '@/components/widgets/area/WidgetAreaPresetLine';
import { WidgetAreaLayoutBar, type WidgetAreaLayoutLabels } from '@/components/widgets/area/WidgetAreaLayoutBar';
import { useCorePageWidgetAreaLayoutBar } from '@/components/widgets/area/useCorePageWidgetAreaLayoutBar';
import {
  useWidgetAreaLayout,
  type WidgetAreaPort,
} from '@/components/widgets/area/useWidgetAreaLayout';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import type { collectMachineAttention } from '@/components/machines/attention/collectMachineAttention';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import { selectMachinesPresetMachine, type MachinesWidgetPresetMachine } from './machinesWidgetPresets';
import { useMachinesWidgetAreaBinding } from './useMachinesWidgetAreaBinding';

/**
 * The All machines dashboard (lab `rw` D, Dp; AGW-19): the person's own widget area under the page sentence —
 * "Overview · Your layout · only you see it" with the platform's one Add/Customize, then, when edited, its
 * Reset/Undo line under that header, then the shared frame. Its default is the static preset; every edit is the platform's layout owner.
 */
export function MachinesDashboardArea(props: Readonly<{
  /** The fleet as the page lists it (its first online machine, its first machine): binds the preset's group. */
  fleet: Readonly<{ firstOnline: MachinesWidgetPresetMachine | null; first: MachinesWidgetPresetMachine | null; onlineKeys: readonly string[]; presenceLoaded: boolean }>;
  /** The same visible Homes and attention census that the page presents. */
  attention: Pick<ReturnType<typeof collectMachineAttention>, 'entries' | 'reportingMachineKeys'>;
}>) {
  const language = usePreferredLanguage();
  const viewer = useActiveServerAccountScope();
  const { serverId } = useActiveServerSnapshot();
  const thisComputer = useThisComputerMachineId();
  const pinnedMachine = React.useMemo(
    () => selectMachinesPresetMachine({
      serverId: serverId ?? null,
      presenceLoaded: props.fleet.presenceLoaded,
      needsYou: props.attention.entries.filter(entry => entry.attention.level === 'needs_you'),
      thisComputerMachineId: thisComputer ?? null,
      reportingMachineKeys: props.attention.reportingMachineKeys,
      fleet: props.fleet,
    }),
    [props.attention, props.fleet, serverId, thisComputer],
  );
  const names = React.useMemo(
    () => ({
      overview: t('machines.widgets.body.presets.overview'),
      machineHealth: t('machines.widgets.body.presets.machineHealth'),
    }),
    [language],
  );
  const binding = useMachinesWidgetAreaBinding({
    serverId: viewer?.serverId ?? '',
    names,
    pinnedMachine,
  });
  if (!binding.port) {
    return (
      <WidgetArea
        port={null}
        context={binding.context}
        geometry="grid"
        title={names.overview}
        meta={t('machines.widgets.body.presets.yourLayout')}
        surfaceName={t('machines.widgets.body.presets.surfaceName')}
        testID="machines.dashboard"
      />
    );
  }
  return (
    <MachinesDashboardDocument
      port={binding.port}
      context={binding.context}
      binding={binding}
      title={names.overview}
    />
  );
}

/** The words this area uses for its named layouts: views, as on Usage. */
const MACHINES_LAYOUT_LABELS: WidgetAreaLayoutLabels = {
  get list() { return t('usage.board.page.viewsLabel'); },
  current: (name) => `${t('usage.board.page.viewsLabel')}: ${name}`,
  get create() { return t('usage.board.page.newView'); },
  get createEllipsis() { return t('usage.board.page.newView'); },
  actions: (name) => t('usage.board.page.viewActions', { name }),
  get rename() { return t('usage.board.page.renameView'); },
  moveBefore: (name) => t('usage.board.page.moveViewBefore', { name }),
  moveAfter: (name) => t('usage.board.page.moveViewAfter', { name }),
  get delete() { return t('usage.board.page.deleteView'); },
  get deleteLabel() { return t('usage.board.page.deleteView'); },
};

/**
 * The area's one header is its named-layout bar (AR-4, as a plugin page's widget section): the Overview preset and
 * the person's own views as tabs, + New view and ⋯ Rename/Move/Delete on the selected one; an edited preset's
 * Reset/Undo line under it; then the widgets with the one dashed Add line.
 */
function MachinesDashboardDocument(
  props: Readonly<{
    port: WidgetAreaPort;
    context: WidgetSurfaceContext;
    binding: ReturnType<typeof useMachinesWidgetAreaBinding>;
    title: string;
  }>,
) {
  const layout = useWidgetAreaLayout(props.port, props.context);
  const ready = layout.state.status === 'ready' ? layout.state : null;
  const presets = React.useMemo(() => props.binding.presets.map(preset => ({ id: preset.id, name: preset.name })), [props.binding.presets]);
  const bar = useCorePageWidgetAreaLayoutBar({ binding: props.binding, area: layout, presets });
  const name = bar.selectedName ?? props.title;
  return (
    <>
      <WidgetAreaLayoutBar
        layouts={bar.layouts}
        selectedId={bar.selectedId}
        onSelect={bar.onSelect}
        onCreate={bar.onCreate}
        actions={bar.actions}
        readFailure={bar.readFailure}
        labels={MACHINES_LAYOUT_LABELS}
        heading="section"
        testID="machines.dashboard.layouts"
      />
      {ready?.preset?.isEdited ? (
        <WidgetAreaPresetLine
          preset={ready.preset}
          surface={ready.surface}
          presetActions={props.binding}
          testID="machines.dashboard.preset"
        />
      ) : null}
      <WidgetArea
        port={props.port}
        context={props.context}
        layout={layout}
        geometry="grid"
        title={name}
        surfaceName={t('machines.widgets.body.presets.surfaceName')}
        dashboard={{ addLabel: t('widgetAdd.areaEmptyAction'), emptyTitle: t('widgetAdd.areaEmptyReason'), holdsEmptyLineWhileLoading: true }}
        testID="machines.dashboard"
      />
    </>
  );
}
