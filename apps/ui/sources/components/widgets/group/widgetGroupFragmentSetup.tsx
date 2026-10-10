import * as React from 'react';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import {
  composeWidgetGroupContextV1,
  getWidgetSizeFootprintV1,
  isSameWidgetDefinitionV1,
  resolveConfiguredWidgetInputs,
  widgetCandidateDefinitionV1,
  type WidgetLayoutFragmentSummaryV1,
  type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';

import type { WidgetAddEntry } from '@/components/widgets/add/widgetAddModel';
import type {
  WidgetSetup,
  WidgetSetupDraft,
  WidgetSetupSubmitResult,
} from '@/components/widgets/add/widgetSetupModel';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { WidgetSetupPreview } from '@/components/widgets/surface/WidgetSetupPreview';
import {
  buildWidgetCandidateSetup,
  widgetProvidedContext,
  widgetSetupFieldsForCandidate,
  type WidgetSurfaceContext,
} from '@/components/widgets/surface/widgetSurfaceSetup';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { WidgetGroupFrame } from './WidgetGroupFrame';
import { resolveWidgetGroupCells, resolveWidgetGroupColumns } from './widgetGroupLayout';
import { resolveWidgetGroupWidthChoices, WIDGET_GROUP_ICON } from './widgetGroupMenu';
import { buildWidgetGroupInputsCandidate } from './widgetGroupInputs';

const NO_VIEWER_VALUES = Object.freeze({});

/** A saved group's widgets as people know them: each one's own name, else the widget it is. */
function describeFragmentChildren(
  fragment: WidgetLayoutFragmentSummaryV1,
  candidates: readonly WidgetCandidate[],
): readonly Readonly<{ title: string; mark: WidgetCandidate['icon'] }>[] {
  return fragment.group.children.map((child) => {
    const candidate = candidates.find((entry) =>
      isSameWidgetDefinitionV1(
        widgetCandidateDefinitionV1(entry),
        child.instance.definition,
      ),
    );
    return {
      title:
        child.instance.displayName ??
        candidate?.title ??
        t('sessionBoard.item.pluginUnavailable.title'),
      mark: candidate?.icon ?? 'squares-four',
    };
  });
}

/**
 * Where a saved group comes from (lab wgsaved A): "Your group · saved from Home on Oct 8 · 3 widgets".
 * The origin and the date are the fragment's own facts; a group saved before they were recorded says
 * only what it is.
 */
export function describeWidgetGroupFragmentProvenance(
  fragment: Pick<WidgetLayoutFragmentSummaryV1, 'origin' | 'createdAt' | 'childCount'>,
): string {
  const origin = fragment.origin?.kind === 'home' ? t('common.home') : fragment.origin?.name ?? null;
  const date = fragment.createdAt === undefined ? null
    : formatWithCachedDateTimeFormatter(fragment.createdAt, getPreferredLanguage(), { month: 'short', day: 'numeric' });
  return t('widgetFrame.groupProvenance', { origin, date, count: fragment.childCount });
}

/**
 * A saved group in the Add list's Your widgets (lab wgsaved G/A): a group mark, a purpose line naming
 * its widgets and "Group · N" as the trailing fact. Its pane asks only the group's inputs and offers
 * width as the only size; Add places one copy of the whole group (`widgets.group.add`). There is no
 * live link to the saved group.
 */
export function buildWidgetGroupFragmentEntry(
  input: Readonly<{
    fragment: WidgetLayoutFragmentSummaryV1;
    candidates: readonly WidgetCandidate[];
    scope: WidgetSurfaceRefV1 | null;
    context: WidgetSurfaceContext;
    submitLabel: string;
    add: (
      fragment: WidgetLayoutFragmentSummaryV1,
      draft: WidgetSetupDraft,
    ) => Promise<WidgetSetupSubmitResult>;
    /** The group as it will arrive, live: its widgets at the draft's inputs and width. */
    renderGroupPreview: (fragment: WidgetLayoutFragmentSummaryV1, draft: WidgetSetupDraft, waiting?: string) => React.ReactNode;
  }>,
): WidgetAddEntry {
  const { fragment } = input;
  const children = describeFragmentChildren(fragment, input.candidates);
  const names = children.map((child) => child.title).join(' · ');
  const setup = (): WidgetSetup => {
    // The group's inputs as a widget's: the same field rows, value buttons and binder.
    const descriptor = {
      inputs: fragment.inputs,
      inputSchema: fragment.inputSchema,
    };
    // Asked once for the whole group: while it is still needed, the row says who follows the answer.
    const askedOnce = t('widgetFrame.groupInputAskedOnce', { count: fragment.childCount });
    const fields = widgetSetupFieldsForCandidate(
      descriptor,
      input.context,
      'personal',
    ).map((entry) => ({ ...entry, neededHint: askedOnce }));
    const providedContext = widgetProvidedContext(input.context);
    const definition = fragment.group.children[0]!.instance.definition;
    const widths = resolveWidgetGroupWidthChoices(
      fragment.group.children.map((child, index) => ({
        instance: { id: String(index) },
        ...(child.size ? { size: child.size } : {}),
      })),
      (id) => children[Number(id)]?.title ?? id,
    );
    return {
      title: fragment.name,
      hint: fragment.description ?? names,
      provenance: describeWidgetGroupFragmentProvenance(fragment),
      submitLabel: input.submitLabel,
      widget: { title: fragment.name, mark: WIDGET_GROUP_ICON },
      fields,
      initial: {
        bindings: fragment.group.context ?? {},
        width: fragment.group.width,
      },
      widthChoices: widths,
      resolve: (draft) =>
        resolveConfiguredWidgetInputs({
          instance: { v: 1, id: 'draft', definition, bindings: draft.bindings },
          descriptor,
          providedContext,
          viewerValues: NO_VIEWER_VALUES,
        }),
      optionsContext: (() => {
        const candidates = fragment.group.children.map(child => input.candidates.find(candidate =>
          isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), child.instance.definition)));
        const candidate = buildWidgetGroupInputsCandidate({ title: fragment.name, candidates });
        // A removed child's declaration cannot become an unscoped source read. Keep a concrete
        // consumer so canonical descriptor admission refuses unavailable or undeclared fields.
        if (!candidate) return () => ({ draftInput: {}, ...(input.scope ? {
          consumer: { kind: 'widget' as const, surface: input.scope, definition },
        } : {}) });
        return buildWidgetCandidateSetup({ candidate: { ...candidate, ...descriptor }, fieldCandidates: candidates,
          context: input.context, audience: 'personal', scope: input.scope,
          mode: { kind: 'edit', instance: { v: 1, id: 'draft', definition, bindings: fragment.group.context ?? {} } },
          submit: draft => input.add(fragment, draft) }).optionsContext;
      })(),
      // The group as it will arrive: its widgets live, at the draft's inputs and width.
      renderPreview: ({ draft }) => input.renderGroupPreview(fragment, draft),
      // The group is its own frame: until its inputs are chosen, the same frame with each widget waiting.
      renderWaitingPreview: ({ draft, waiting }) => input.renderGroupPreview(fragment, draft, waiting),
      describeOutcome: ({ values }) => t('widgetFrame.groupAddsFollowing', {
        name: fragment.name, count: fragment.childCount, value: values[0] ?? null,
      }),
      submit: (draft) => input.add(fragment, draft),
    };
  };
  return {
    id: `group-${fragment.artifactId}`,
    title: fragment.name,
    subtitle: fragment.description ?? names,
    icon: WIDGET_GROUP_ICON,
    count: t('widgetFrame.groupCount', { count: fragment.childCount }),
    setup,
  };
}

/**
 * A saved group's live preview in its Add pane (lab wgsaved A): the real group frame with each widget's
 * real body, following the draft's group inputs (composed with what the surface fills) at the chosen
 * width. Each widget still reads with its own admission; a widget whose type is gone shows its repair.
 */
export function WidgetGroupFragmentPreview(props: Readonly<{
  fragment: WidgetLayoutFragmentSummaryV1;
  draft: WidgetSetupDraft;
  candidates: readonly WidgetCandidate[];
  scope: WidgetSurfaceRefV1;
  providedContext: Readonly<Record<string, readonly JsonValue[]>>;
  phone: boolean;
  /** Inputs are still needed: each widget's body says what it waits for instead of reading. */
  waiting?: string | undefined;
  testID: string;
}>) {
  const { theme } = useUnistyles();
  const { fragment, draft } = props;
  const width = draft.width ?? fragment.group.width;
  const groupContext = React.useMemo(() => composeWidgetGroupContextV1({ providedContext: props.providedContext, groupBindings: draft.bindings }),
    [draft.bindings, props.providedContext]);
  const children = fragment.group.children.map((child, index) => ({ id: String(index), child,
    candidate: props.candidates.find(entry => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(entry), child.instance.definition)) ?? null }));
  const cells = resolveWidgetGroupCells(props.scope.owner.kind, children.map(entry => ({ id: entry.id, size: entry.child.size })));
  return (
    <WidgetGroupFrame
      testID={props.testID}
      group={{ id: props.fragment.artifactId, frameStyle: fragment.group.frameStyle, dividers: fragment.group.dividers }}
      placement="home"
      cells={cells}
      columns={resolveWidgetGroupColumns(width, props.phone)}
      customizing={false}
      title={fragment.group.title ?? null}
      accessibilityLabel={fragment.name}
      renderChild={(id) => {
        const entry = children[Number(id)];
        if (!entry) return null;
        const title = entry.child.instance.displayName ?? entry.candidate?.title ?? t('sessionBoard.item.pluginUnavailable.title');
        const size = entry.child.size;
        const footprint = size ? getWidgetSizeFootprintV1(props.scope.owner.kind, size) : undefined;
        return (
          <WidgetFrame testID={`${props.testID}.${id}`} frameStyle="plain" grouped placement="home"
            {...(size && footprint ? { widgetPresentation: { size, footprint } } : {})}
            mark={entry.candidate?.icon ?? 'squares-four'} title={title}
            body={{ kind: 'content', children: props.waiting ? (
              <View style={styles.waitingBody}>
                <Icon name={entry.candidate?.icon ?? 'squares-four'} size={ICON_SIZE.sm} color={theme.colors.text.tertiary} />
                <Text style={styles.waiting}>{props.waiting}</Text>
              </View>
            ) : entry.candidate ? (
              <WidgetSetupPreview scope={props.scope} providedContext={groupContext} candidate={entry.candidate}
                draft={{ bindings: entry.child.instance.bindings, ...(size ? { size } : {}) }} testID={`${props.testID}.${id}.body`} />
            ) : null }} />
        );
      }}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  waitingBody: { flexGrow: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  waiting: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
  },
}));
