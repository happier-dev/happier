import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  getWidgetSizeFootprintV1,
  readBuiltinWidgetDescriptorV1,
  type BuiltinWidgetIdV1,
  type WidgetInputBindingsV1,
  type WidgetLayoutGroupV1,
  type WidgetSizeV1,
} from '@happier-dev/protocol/widgets';

import { ChangesGlanceView } from '@/components/sessions/companion/glances/ChangesGlance';
import { resolveLocalServicesGlanceRows } from '@/components/sessions/companion/glances/glanceModels';
import { LocalServicesGlanceView } from '@/components/sessions/companion/glances/LocalServicesGlance';
import { SessionAgentPlanCard } from '@/components/sessions/companion/plan/SessionAgentPlanCard';
import { buildSessionScmSummary } from '@/components/sessions/sourceControl/status/statusSummary';
import { EntityDragGrip } from '@/components/ui/treeDragDrop/ui/EntityReleasePreview';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { WidgetGroupFrame } from '@/components/widgets/group/WidgetGroupFrame';
import { WidgetGroupBar } from '@/components/widgets/group/WidgetGroupBar';
import { widgetGroupFollowSource, widgetGroupPinnedSource } from '@/components/widgets/group/widgetGroupInputs';
import { WidgetGroupMenuButton } from '@/components/widgets/group/WidgetGroupMenuButton';
import {
  type WidgetGroupMenuInput,
  type WidgetGroupOperations,
} from '@/components/widgets/group/widgetGroupMenu';
import {
  resolveWidgetGroupCells,
  resolveWidgetGroupColumns,
} from '@/components/widgets/group/widgetGroupLayout';
import { selectLocalServiceRunningCount } from '@/sync/domains/local/services/serviceRow';
import { t } from '@/text';

import { PLAN } from './frameSpecimens';
import { SERVICE_ROWS, SNAPSHOT } from './glanceSpecimens';
import type { WidgetSpecimenFrames } from './widgetSpecimenTypes';

/**
 * Widget groups at static props (lab `widget-groups` wgpres, wgvar, wgmenu, wgphone): the real group
 * frame around real widget frames whose bodies are Happier's real built-in bodies (Agent plan,
 * Changes, Local services) over the lab session's data, so the build pairs against the lab at the
 * same component width without a live Home.
 */

export type GroupSpecimenChild = Readonly<{
  id: string;
  builtin: BuiltinWidgetIdV1;
  size: WidgetSizeV1;
  source?: string;
  follows?: string;
}>;

const NOOP = (): void => {};
const OPERATIONS: WidgetGroupOperations = {
  setWidth: NOOP,
  setFrame: NOOP,
  setDividers: NOOP,
  ungroup: NOOP,
  remove: NOOP,
  move: NOOP,
  create: NOOP,
};
const SOURCE = 'Fix settings modal remount';

function group(
  id: string,
  children: readonly GroupSpecimenChild[],
  options: Partial<
    Pick<
      WidgetLayoutGroupV1,
      'title' | 'width' | 'frameStyle' | 'dividers' | 'context'
    >
  > = {},
): WidgetLayoutGroupV1 {
  return {
    kind: 'group',
    id,
    width: options.width ?? 'full',
    frameStyle: options.frameStyle ?? 'card',
    dividers: options.dividers ?? 'hairline',
    ...(options.title ? { title: options.title } : {}),
    ...(options.context ? { context: options.context } : {}),
    children: children.map((child) => ({
      kind: 'widget' as const,
      size: child.size,
      instance: {
        v: 1,
        id: child.id,
        definition: { kind: 'builtin' as const, id: child.builtin },
        bindings: {},
      },
    })),
  };
}

/** The real built-in body for each child, as Home mounts it inside the widget frame. */
function ChildBody(props: Readonly<{ child: GroupSpecimenChild }>) {
  const testID = `group-specimen.${props.child.id}.body`;
  switch (props.child.builtin) {
    case 'agent_plan':
      return (
        <SessionAgentPlanCard
          plan={PLAN}
          agentLabel="Claude"
          activity="working"
          presentation="body"
          testID={testID}
        />
      );
    case 'changes': {
      const summary = buildSessionScmSummary(SNAPSHOT);
      return summary ? (
        <ChangesGlanceView
          presentation="body"
          frameStyle="plain"
          state={{ kind: 'ready', summary }}
          onReviewChanges={NOOP}
          testID={testID}
        />
      ) : null;
    }
    default:
      return (
        <LocalServicesGlanceView
          presentation="body"
          frameStyle="plain"
          machineName="MacBook Pro"
          onOpen={NOOP}
          testID={testID}
          state={{
            kind: 'ready',
            rows: resolveLocalServicesGlanceRows(SERVICE_ROWS),
            runningCount: selectLocalServiceRunningCount(SERVICE_ROWS),
          }}
        />
      );
  }
}

function ChildFrame(
  props: Readonly<{ child: GroupSpecimenChild; wide: boolean; phone: boolean; grip?: boolean }>,
) {
  const descriptor = readBuiltinWidgetDescriptorV1({
    kind: 'builtin',
    id: props.child.builtin,
  })!;
  const follows = props.child.follows;
  return (
    <WidgetFrame
      testID={`group-specimen.${props.child.id}`}
      frameStyle="plain"
      grouped
      placement="home"
      widgetPresentation={{
        size: props.child.size,
        footprint: getWidgetSizeFootprintV1('home', props.child.size)!,
      }}
      mark={descriptor.icon}
      compactHeader={!props.wide && !props.phone}
      {...(props.grip ? { leading: <EntityDragGrip accessibilityLabel="Move" /> } : {})}
      title={t(descriptor.titleKey)}
      {...(follows
        ? { source: widgetGroupFollowSource(follows, props.wide || props.phone) }
        : { source: props.child.source ?? SOURCE })}
      body={{ kind: 'content', children: <ChildBody child={props.child} /> }}
    />
  );
}

function menuInput(
  value: WidgetLayoutGroupV1,
  byId: ReadonlyMap<string, GroupSpecimenChild>,
  extra: Partial<WidgetGroupMenuInput> = {},
): WidgetGroupMenuInput {
  return {
    group: value,
    childTitle: (id) => {
      const child = byId.get(id);
      return child
        ? t(
            readBuiltinWidgetDescriptorV1({
              kind: 'builtin',
              id: child.builtin,
            })!.titleKey,
          )
        : id;
    },
    operations: OPERATIONS,
    showWidth: true,
    editInputs: undefined, onRename: undefined, onSave: undefined, onAddTo: undefined,
    ...extra,
  };
}

/** One group at static props; `customizing` shows it as its surface's Customize does (bar, grips, slot). */
export function GroupSpecimen(
  props: Readonly<{
    id: string;
    items: readonly GroupSpecimenChild[];
    phone: boolean;
    customizing?: boolean;
    bar?: boolean;
    options?: Parameters<typeof group>[2];
    menuTestID?: string;
    menuInputExtra?: Partial<WidgetGroupMenuInput>;
  }>,
) {
  const value = group(props.id, props.items, props.options);
  const byId = new Map(props.items.map((child) => [child.id, child]));
  const pinned = value.context ? 'happier' : null;
  return (
    <WidgetGroupFrame
      testID={`group-specimen.${props.id}`}
      group={value}
      placement="home"
      cells={resolveWidgetGroupCells(
        'home',
        props.items.map((child) => ({ id: child.id, size: child.size })),
      )}
      columns={resolveWidgetGroupColumns(value.width, props.phone)}
      customizing={props.customizing === true}
      title={props.customizing ? null : value.title ?? null}
      source={pinned ? widgetGroupPinnedSource(pinned) : undefined}
      menu={<WidgetGroupMenuButton visible testID={props.menuTestID ?? `group-specimen.${props.id}.menu`} input={menuInput(value, byId, { showWidth: !props.phone, ...props.menuInputExtra })} />}
      {...(props.bar
        ? {
            bar: (
              <WidgetGroupBar
                input={menuInput(value, byId, { showWidth: !props.phone })}
                onRename={NOOP}
                grip={<EntityDragGrip accessibilityLabel="Move" />}
                testID={`group-specimen.${props.id}.bar`}
              />
            ),
          }
        : {})}
      accessibilityLabel={value.title ?? 'Group'}
      renderChild={(id, placement) => (
        <ChildFrame
          child={byId.get(id)!}
          wide={placement.wide}
          phone={props.phone}
          grip={props.customizing === true}
        />
      )}
      onAddToGroup={NOOP}
    />
  );
}

export const PLAN_WIDE: GroupSpecimenChild = { id: 'plan', builtin: 'agent_plan', size: 'wide' };
export const CHANGES: GroupSpecimenChild = { id: 'changes', builtin: 'changes', size: 'medium' };
export const SERVICES: GroupSpecimenChild = {
  id: 'services',
  builtin: 'local_services',
  size: 'small',
  source: 'MacBook Pro · relay-retry',
};
export const SERVICES_2: GroupSpecimenChild = {
  id: 'services-2',
  builtin: 'local_services',
  size: 'small',
  source: 'devbox · relay-retry',
};
export const FOLLOW_CHANGES: GroupSpecimenChild = {
  id: 'follow-changes',
  builtin: 'changes',
  size: 'small',
  follows: 'happier',
};
export const FOLLOW_SERVICES: GroupSpecimenChild = {
  id: 'follow-services',
  builtin: 'local_services',
  size: 'small',
  follows: 'happier',
};
const PINNED: WidgetInputBindingsV1 = {
  project: { kind: 'value', value: 'happier' },
};

export const GROUP_SPECIMEN_FRAMES: WidgetSpecimenFrames = {
  /** wgpres D: the full group with a wide child, a Medium beside two Smalls; and a group pinned to an input with followers. */
  WGPRES: ({ phone }) => (
    <View style={stylesheet.stack}>
      <GroupSpecimen
        id="happier"
        phone={phone}
        items={[PLAN_WIDE, CHANGES, SERVICES, SERVICES_2]}
        options={{ title: 'happier' }}
      />
      <GroupSpecimen
        id="inputs"
        phone={phone}
        items={[FOLLOW_CHANGES, FOLLOW_SERVICES]}
        options={{ title: 'happier', context: PINNED }}
      />
    </View>
  ),
  /** wgvar B: Card · None, Plain · Lines, an untitled group, and the lone child in view and in Customize. */
  WGVAR: ({ phone }) => (
    <View style={stylesheet.stack}>
      <GroupSpecimen
        id="none"
        phone={phone}
        items={[CHANGES, SERVICES, SERVICES_2]}
        options={{ title: 'happier', dividers: 'none' }}
      />
      <GroupSpecimen
        id="plain"
        phone={phone}
        items={[CHANGES, SERVICES, SERVICES_2]}
        options={{ title: 'happier', frameStyle: 'plain' }}
      />
      <GroupSpecimen
        id="lone"
        phone={phone}
        items={[SERVICES, SERVICES_2, FOLLOW_CHANGES]}
      />
      <GroupSpecimen
        id="customize"
        phone={phone}
        customizing
        bar
        items={[SERVICES, SERVICES_2, FOLLOW_CHANGES]}
      />
    </View>
  ),
  /** wgmenu M: the group ⋯ open, Width unavailable with the widget that prevents it. */
  WGMENU: ({ phone }) => (
      <GroupSpecimen id="happier" phone={phone}
          items={[PLAN_WIDE, CHANGES, SERVICES, SERVICES_2]}
          options={{ title: 'happier', context: PINNED }}
          menuTestID="menu"
          menuInputExtra={{
            editInputs: { onPress: NOOP, binding: 'Project: happier' },
            onRename: NOOP,
            onSave: NOOP,
            onAddTo: NOOP,
          }}
      />
  ),
};

const stylesheet = StyleSheet.create(() => ({
  stack: { gap: 16 },
}));
