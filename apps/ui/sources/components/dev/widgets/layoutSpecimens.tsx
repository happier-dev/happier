import * as React from 'react';
import { View } from 'react-native';
import type { WidgetLayoutFragmentSummaryV1 } from '@happier-dev/protocol/widgets';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Text } from '@/components/ui/text/Text';
import { buildHomeWidgetAddSections } from '@/components/widgets/add/HomeWidgetAddPopover';
import {
  WIDGET_ADD_SURFACE_PX,
  WidgetAddPanel,
} from '@/components/widgets/add/WidgetAddSurface';
import {
  WidgetAreaLayoutBar,
  type WidgetAreaLayoutLabels,
  type WidgetAreaLayoutOption,
} from '@/components/widgets/area/WidgetAreaLayoutBar';
import { WidgetAreaPresetLine } from '@/components/widgets/area/WidgetAreaPresetLine';
import { WidgetGroupFragmentPreview } from '@/components/widgets/group/widgetGroupFragmentSetup';
import { selectBuiltinWidgetCandidates } from '@/components/widgets/widgetCatalog';
import { SheetDismissProvider } from '@/modal/components/card/sheetDragDismiss';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import { t } from '@/text';

import type { WidgetSpecimenFrames } from './widgetSpecimenTypes';

/**
 * Dev-only fixtures for an area's named layouts and saved groups (lab `widget-groups` wgsaved G/A/R):
 * the one layout tab bar with a Project's and a core page's data, the edited preset's line, and the
 * Add surface opened on a saved group. Real components at static props; nothing reads a Home.
 */

const NOOP = (): void => {};
const ACCEPT = async () => ({ ok: true as const });
const HOME_SCOPE = {
  serverId: 'specimen',
  accountId: 'specimen',
  owner: { kind: 'home' as const },
};
const USAGE_SURFACE = {
  serverId: 'specimen',
  accountId: 'specimen',
  owner: {
    kind: 'corePage' as const,
    pageId: 'usage',
    area: 'main',
    layoutId: 'overview',
  },
};

const PROJECT_LABELS: WidgetAreaLayoutLabels = {
  list: 'Dashboards',
  current: (name) => `Dashboard: ${name}`,
  create: 'Create dashboard',
  createEllipsis: 'Create dashboard…',
  defaultLayout: 'Default',
  actions: (name) => `${name} actions`,
  rename: 'Rename',
  moveBefore: (name) => `Move before ${name}`,
  moveAfter: (name) => `Move after ${name}`,
  delete: 'Delete dashboard',
  deleteLabel: 'Delete',
};
const USAGE_LABELS: WidgetAreaLayoutLabels = {
  ...PROJECT_LABELS,
  list: 'Usage views',
  current: (name) => `Usage views: ${name}`,
  create: 'New view from this layout',
  createEllipsis: 'New view from this layout',
};
const PROJECT_LAYOUTS: readonly WidgetAreaLayoutOption[] = [
  { id: 'overview', name: 'Overview', isDefault: true, edited: true },
  { id: 'release', name: 'Release' },
  { id: 'growth', name: 'Growth' },
];
const USAGE_LAYOUTS: readonly WidgetAreaLayoutOption[] = [
  { id: 'overview', name: 'Overview', icon: 'squares-four', edited: true },
  { id: 'costs', name: 'Costs', icon: 'currency-dollar' },
  { id: 'work', name: 'Work', icon: 'git-pull-request' },
  { id: 'usage', name: 'Usage', icon: 'list-bullets' },
  { id: 'coach', name: 'Coach', icon: 'sparkle' },
  { id: 'how-you-work', name: 'How you work', icon: 'clock' },
  { id: 'sources', name: 'Sources', icon: 'stack' },
];
const ACTIONS = { rename: NOOP, delete: { onPress: NOOP } };

const widget = (id: string, definition: string) => ({
  kind: 'widget' as const,
  instance: {
    v: 1 as const,
    id,
    definition: { kind: 'builtin' as const, id: definition },
    bindings: {},
  },
});

function Caption(props: Readonly<{ children: string }>) {
  return (
    <Text style={{ fontSize: 11, lineHeight: 14, opacity: 0.5 }}>
      {props.children}
    </Text>
  );
}

/** Project and Usage through the one bar, at the same width, then the edited preset's line. */
function LayoutBars(props: Readonly<{ phone: boolean }>) {
  return (
    <View style={{ width: props.phone ? 358 : 1100, gap: 18 }}>
      <Caption>Project · dashboards</Caption>
      <WidgetAreaLayoutBar
        layouts={PROJECT_LAYOUTS}
        selectedId="overview"
        onSelect={NOOP}
        narrow={props.phone}
        onCreate={NOOP}
        actions={ACTIONS}
        labels={PROJECT_LABELS}
        testID="specimen-project-layouts"
      />
      <Caption>Usage · views</Caption>
      <WidgetAreaLayoutBar
        layouts={USAGE_LAYOUTS}
        selectedId="overview"
        onSelect={NOOP}
        narrow={props.phone}
        onCreate={NOOP}
        actions={null}
        labels={USAGE_LABELS}
        testID="specimen-usage-layouts"
      />
      <WidgetAreaPresetLine
        testID="specimen-preset-line"
        surface={USAGE_SURFACE}
        preset={{
          id: 'overview',
          name: 'Overview',
          isEdited: true,
          changes: [
            {
              kind: 'moved',
              direction: 'up',
              item: {
                ...widget('limits', 'usage_capacity'),
                instance: {
                  ...widget('limits', 'usage_capacity').instance,
                  displayName: 'Limits',
                },
              },
            },
            {
              kind: 'removed',
              item: {
                ...widget('days', 'usage_rhythm'),
                instance: {
                  ...widget('days', 'usage_rhythm').instance,
                  displayName: 'Active days',
                },
              },
            },
          ],
        }}
      />
      <WidgetAreaPresetLine
        testID="specimen-preset-line-more"
        surface={USAGE_SURFACE}
        preset={{
          id: 'overview',
          name: 'Overview',
          isEdited: true,
          changes: [
            { kind: 'added', item: widget('coach', 'usage_coach') },
            { kind: 'changed', item: widget('daily', 'usage_daily') },
            { kind: 'removed', item: widget('recap', 'usage_recap') },
            { kind: 'renamed' },
          ],
        }}
      />
    </View>
  );
}

const PROJECT_FIELD = {
  path: 'project',
  title: 'Project',
  widget: 'select' as const,
  required: true,
  optionsSourceId: 'specimen.projects',
};

/** A group saved from Home: three built-in widgets that follow one project. */
function releaseCheck(
  context: 'needed' | 'answered',
): WidgetLayoutFragmentSummaryV1 {
  return {
    artifactId: 'release-check',
    name: 'Release check',
    description: 'Checks, open PRs and local services for one project',
    childCount: 3,
    inputs: { fields: [PROJECT_FIELD] },
    inputSchema: { type: 'object' },
    origin: { kind: 'home' },
    createdAt: Date.UTC(2026, 9, 8, 12),
    group: {
      width: 'half',
      frameStyle: 'card',
      dividers: 'hairline',
      title: 'Release check',
      ...(context === 'answered'
        ? { context: { project: { kind: 'value' as const, value: 'happier' } } }
        : {}),
      children: ['changes', 'agent_plan', 'local_services'].map(
        (id) => ({
          kind: 'widget' as const,
          size: 'small' as const,
          instance: {
            v: 1 as const,
            definition: { kind: 'builtin' as const, id },
            bindings: {},
          },
        }),
      ),
    },
  };
}

/** A group whose inputs are the usage widgets' own (the shape live QA saved): several inputs, typed lists. */
function usageGroup(): WidgetLayoutFragmentSummaryV1 {
  const candidates = selectBuiltinWidgetCandidates();
  const summary = candidates.find(
    (candidate) =>
      candidate.definition?.kind === 'builtin' &&
      candidate.definition.id === 'usage_period_summary',
  )!;
  return {
    artifactId: 'usage-group',
    name: 'Morning glance',
    childCount: 2,
    inputs: {
      fields: [...(summary.inputs?.fields ?? [])].map((field) =>
        field.path === 'period' || field.path === 'agents'
          ? { ...field, required: true }
          : field,
      ),
    },
    inputSchema: { type: 'object' },
    createdAt: Date.UTC(2026, 9, 9, 12),
    origin: { kind: 'project', name: 'happier' },
    group: {
      width: 'half',
      frameStyle: 'card',
      dividers: 'hairline',
      children: ['usage_period_summary', 'usage_daily'].map((id) => ({
        kind: 'widget' as const,
        size: 'small' as const,
        instance: {
          v: 1 as const,
          definition: { kind: 'builtin' as const, id },
          bindings: {},
        },
      })),
    },
  };
}

/** The Add surface opened on a saved group (lab wgsaved G unanswered, A answered). */
function SavedGroupAdd(
  props: Readonly<{ phone: boolean; fragment: WidgetLayoutFragmentSummaryV1 }>,
) {
  const { fragment } = props;
  const sections = React.useMemo(() => {
    const candidates = selectBuiltinWidgetCandidates();
    return buildHomeWidgetAddSections({
      candidates,
      instances: [],
      addInstance: async () => {},
      scope: HOME_SCOPE,
      fragments: [fragment],
      addGroup: ACCEPT,
      renderGroupPreview: (saved, draft, waiting) => (
        <WidgetGroupFragmentPreview
          fragment={saved}
          draft={draft}
          candidates={candidates}
          scope={HOME_SCOPE}
          phone={props.phone}
          // A live body needs a running Home; the specimen keeps each widget's waiting body.
          waiting={waiting ?? 'Live body (needs a running Home)'}
          providedContext={{}}
          testID="specimen-group-preview"
        />
      ),
    });
  }, [fragment, props.phone]);
  const panel = (
    <WidgetAddPanel
      testID="specimen-add-group"
      title={t('widgetAdd.homeTitle')}
      hint={t('widgetAdd.homeHint')}
      searchPlaceholder={t('widgetAdd.searchWidgets')}
      addLabel={t('widgetAdd.addToHome')}
      composition={props.phone ? 'push' : 'split'}
      phone={props.phone}
      sections={sections}
      initialEntryId={`group-${fragment.artifactId}`}
      onRequestClose={NOOP}
    />
  );
  return props.phone ? (
    <View style={{ width: 390, height: 760, justifyContent: 'flex-end' }}>
      <SheetDismissProvider onDismiss={NOOP}>
        <ModalCardFrame
          header="none"
          title={t('widgetAdd.homeTitle')}
          presentation="sheet"
          testID="specimen-add-group.sheet"
        >
          {panel}
        </ModalCardFrame>
      </SheetDismissProvider>
    </View>
  ) : (
    <View style={{ width: WIDGET_ADD_SURFACE_PX.width }}>
      <FloatingOverlay
        maxHeight={WIDGET_ADD_SURFACE_PX.height}
        scrollEnabled={false}
      >
        <View style={{ height: WIDGET_ADD_SURFACE_PX.height }}>{panel}</View>
      </FloatingOverlay>
    </View>
  );
}

export const LAYOUT_SPECIMEN_FRAMES: WidgetSpecimenFrames = {
  LTABS: ({ phone }) => <LayoutBars phone={phone} />,
  LSAVEDG: ({ phone }) => (
    <SavedGroupAdd phone={phone} fragment={releaseCheck('needed')} />
  ),
  LSAVEDA: ({ phone }) => (
    <SavedGroupAdd phone={phone} fragment={releaseCheck('answered')} />
  ),
  LSAVEDU: ({ phone }) => (
    <SavedGroupAdd phone={phone} fragment={usageGroup()} />
  ),
};
