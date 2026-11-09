import * as React from 'react';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import {
  composeWidgetGroupContextV1,
  getWidgetSizeFootprintV1,
  isSameWidgetDefinitionV1,
  resolveConfiguredWidgetInputs,
  widgetCandidateDefinitionV1,
  translateWidgetPublicProfileCopyV1,
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
import { resolveWidgetInstanceTitle, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { WidgetGroupFrame } from './WidgetGroupFrame';
import { readWidgetGroupTitle } from './widgetGroupTitle';
import { resolveWidgetGroupCells } from '@happier-dev/plugin-ui/components';
import { resolveWidgetGroupColumns } from '@happier-dev/plugin-ui/presentation';
import { resolveWidgetGroupWidthChoices, WIDGET_GROUP_ICON } from './widgetGroupMenu';
import { buildWidgetGroupInputsCandidate } from './widgetGroupInputs';
import { isPublicProfileWidgetSurfaceV1 } from '@happier-dev/protocol/widgets';
import { PublicProfileWidgetPreviewBoundary } from '@/components/settings/account/publicProfile/PublicProfileWidgetSurface';
import type { ProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';

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
      title: resolveWidgetInstanceTitle(child.instance, candidate),
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
    const publicArea = input.scope !== null && isPublicProfileWidgetSurfaceV1(input.scope);
    let prepared = fragment;
    let publicAvailable = true;
    if (publicArea) {
      const children = fragment.group.children.flatMap(child => {
        const candidate = input.candidates.find(entry => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(entry), child.instance.definition));
        const instance = candidate && translateWidgetPublicProfileCopyV1({ ...child.instance, id: 'preview' }, candidate);
        if (!instance) { publicAvailable = false; return []; }
        const { id: _previewId, ...copy } = instance;
        return [{ ...child, instance: copy }];
      });
      const { context: _privateContext, ...group } = fragment.group;
      prepared = { ...fragment, group: { ...group, children } };
    }
    // The group's inputs as a widget's: the same field rows, value buttons and binder.
    const descriptor = publicArea ? { inputs: { fields: [] }, inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false } } : {
      inputs: fragment.inputs,
      inputSchema: fragment.inputSchema,
    };
    // Asked once for the whole group: the first input it is still needed for says who follows the
    // answers, once, rather than every row repeating the same sentence.
    const askedOnce = t('widgetFrame.groupInputAskedOnce', { count: fragment.childCount });
    const baseFields = widgetSetupFieldsForCandidate(
      descriptor,
      input.context,
      'personal',
    );
    const firstRequired = baseFields.findIndex((entry) => entry.field.required === true);
    const fields = baseFields.map((entry, index) => (index === firstRequired ? { ...entry, neededHint: askedOnce } : entry));
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
      hint: publicArea ? t('publicIdentity.editor.copyHint') : fragment.description ?? names,
      provenance: describeWidgetGroupFragmentProvenance(fragment),
      submitLabel: input.submitLabel,
      widget: { title: fragment.name, mark: WIDGET_GROUP_ICON },
      fields,
      initial: {
        bindings: publicArea ? {} : fragment.group.context ?? {},
        width: fragment.group.width,
      },
      widthChoices: widths,
      resolve: (draft) => publicArea ? publicAvailable && Object.keys(draft.bindings).length === 0
        ? { status: 'ready', input: {} }
        : { status: 'denied', fields: [{ path: 'input', status: 'denied', reasonCode: 'widget_public_profile_presentation_unavailable' }] }
        : resolveConfiguredWidgetInputs({
          instance: { v: 1, id: 'draft', definition, bindings: draft.bindings },
          descriptor,
          providedContext,
          viewerValues: NO_VIEWER_VALUES,
        }),
      optionsContext: (() => {
        if (publicArea) return () => ({ draftInput: {} });
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
      renderPreview: ({ draft }) => publicArea && !publicAvailable ? null : input.renderGroupPreview(prepared, draft),
      // The group is its own frame: until its inputs are chosen, the same frame with each widget waiting.
      renderWaitingPreview: ({ draft, waiting }) => publicArea && !publicAvailable ? null : input.renderGroupPreview(prepared, draft, waiting),
      // One answer the widgets follow is worth naming ("following happier"); several are already on
      // screen above the line, and naming only the first would read as the group's one value.
      describeOutcome: ({ values }) => t('widgetFrame.groupAddsFollowing', {
        name: fragment.name, count: fragment.childCount, value: values.length === 1 ? values[0]! : null,
      }),
      submit: (draft) => input.add(publicArea && publicAvailable ? prepared : fragment, draft),
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
  projectContext?: ProjectWidgetAreaContextV1 | null;
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
  const body = (
    <WidgetGroupFrame
      testID={props.testID}
      group={{ id: props.fragment.artifactId, frameStyle: fragment.group.frameStyle, dividers: fragment.group.dividers }}
      placement="home"
      cells={cells}
      columns={resolveWidgetGroupColumns(width, props.phone)}
      customizing={false}
      title={readWidgetGroupTitle(fragment.group) ?? null}
      accessibilityLabel={fragment.name}
      renderChild={(id) => {
        const entry = children[Number(id)];
        if (!entry) return null;
        const title = resolveWidgetInstanceTitle(entry.child.instance, entry.candidate);
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
                projectContext={props.projectContext}
                draft={{ bindings: entry.child.instance.bindings, ...(size ? { size } : {}) }} testID={`${props.testID}.${id}.body`} />
            ) : null }} />
        );
      }}
    />
  );
  return isPublicProfileWidgetSurfaceV1(props.scope)
    ? <PublicProfileWidgetPreviewBoundary scope={props.scope}>{body}</PublicProfileWidgetPreviewBoundary> : body;
}

const styles = StyleSheet.create((theme) => ({
  waitingBody: { flexGrow: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: theme.space.s6 },
  waiting: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
  },
}));
