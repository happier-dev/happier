import * as React from 'react';
import { View } from 'react-native';
import {
  CollectionConditionEditor, HAPPIER_COLLECTION_CONDITION_EDITOR_METRICS, Popover, Select, useHappierCollectionLayout,
  type CollectionConditionEdit, type CollectionConditionModel, type CollectionToolbarProps,
  type EntityListFilterResultV1, type HappierCollectionConditionEditorLabels, type MenuGroup, type SheetMenuContentControls,
} from '@happier-dev/plugin-ui';

import {
  CORPUS_SMART_PRECEDENCE_TUPLES_V1,
  type CorpusSmartPolicyV1,
} from '../../corpus/query/smartPolicy.js';
import type { TriageFilterFacetValueV1, TriageSurfaceStateV1 } from '../state/surface.js';
import type { TriageListShellStateV1, TriageTextResolverV1 } from '../shell/windowState.js';
import type { TriageFilterFacetPlanV1 } from './plan.js';

/**
 * The one lens control group (`core/SURFACE.md` §6).
 *
 * Every control here is the shared public option control, so the roving focus,
 * the checked/selected semantics, the platform touch-target floor and the
 * disabled treatment are all owned by `plugin-ui` and reached through props.
 * Triage decides only which already-projected words go in which control and
 * which reducer action one press means — there is no Triage Pressable, chip
 * component, popover or focus handling in this file.
 *
 * **One composition on a wide page (D4-A, 2026-10-11).** The five facets sit
 * behind one labelled **Filters** trigger presented by the public `Menu` of
 * labelled checkbox groups, so the portal, the initial focus, dismissal, focus
 * return, Escape and Android Back are the host's — Triage supplies the groups
 * and nothing else. Every selected value is already said, and removable, as a token in the
 * list's search field (the shell's `searchTokens`), so a toolbar pill per facet
 * would state each constraint twice and turn the lab's one calm search row into
 * a row of grey pills. §6 allows the facets to stay exposed on wide layouts; it
 * does not require it, and the tokens are what keep the narrowing visible.
 *
 * **Views and Order stay separate on a wide page.** The table puts Order in its title
 * column; list and board keep the toolbar control. They are separate lens questions —
 * which saved lens this is, and which ladder ranks it.
 *
 * **One filter UI at every width.** When the shared `CollectionToolbar` folds (a phone,
 * or a row that no longer fits), its round, counted Filters button (lab
 * `merged-list-phone`) opens the SAME condition editor in the shared sheet
 * (`TriageFilterSheet`), finished by "Show N results"; Order and Smart order join ⋯
 * as radio groups (`readTriageOrderChoicesV1`). Views stays in the toolbar at every width.
 */

export type TriageFilterRailPropsV1 = Readonly<{
  facets: readonly TriageFilterFacetPlanV1[];
  order: TriageSurfaceStateV1['order'];
  smartPolicy: CorpusSmartPolicyV1;
  text: TriageTextResolverV1;
  onToggleFilterValue: (selection: TriageFilterFacetValueV1) => void;
  onClearFilters: () => void;
  /** Empties one facet whole: the filter editor's row remove. */
  onClearFacet: (facet: TriageFilterFacetPlanV1['facet']) => void;
  /** What the narrowed window holds, said in the filter editor's footer ("9 items", "9 loaded · more may match"). */
  result?: EntityListFilterResultV1;
  onChangeOrder: (order: TriageSurfaceStateV1['order']) => void;
  onChangeSmartPolicy: (smartPolicy: CorpusSmartPolicyV1) => void;
}>;

const ORDER_COPY: readonly (readonly [TriageSurfaceStateV1['order'], string, string])[] = [
  ['newest', 'plugins.triage.surface.order.newest', 'Newest'],
  ['oldest', 'plugins.triage.surface.order.oldest', 'Oldest'],
  ['smart', 'plugins.triage.surface.order.smart', 'Smart'],
];

/** The same named ladders for the toolbar and the Collection's table title. */
export function readTriageOrderOptionsV1(text: TriageTextResolverV1): readonly Readonly<{
  key: TriageSurfaceStateV1['order'];
  label: string;
}>[] {
  return ORDER_COPY.map(([key, labelKey, fallback]) => ({ key, label: text(labelKey, fallback) }));
}

/**
 * The two closed Smart ladders, named by what the reader actually gets.
 *
 * The stored value is a precedence tuple, and its first predicate names the
 * whole ladder — so these are two options over one canonical vocabulary rather
 * than a policy editor.
 */
const SMART_PRECEDENCE_COPY: readonly (readonly [
  CorpusSmartPolicyV1['precedence'][number],
  string,
  string,
])[] = [
  ['attention', 'plugins.triage.surface.smartPolicy.attentionFirst', 'What needs you first'],
  ['activity', 'plugins.triage.surface.smartPolicy.activityFirst', 'Most recent activity first'],
];

const ORDER_ROW_PREFIX = 'triage-order:';
const SMART_ROW_PREFIX = 'triage-smart:';

/**
 * Order (and Smart order beside Smart) as the folded toolbar's ⋯ radio groups: the wide row's two pickers, carrying
 * the current choice, where a phone keeps its rare list actions.
 */
export function readTriageOrderChoicesV1(props: Readonly<{
  order: TriageSurfaceStateV1['order'];
  smartPolicy: CorpusSmartPolicyV1;
  text: TriageTextResolverV1;
  onChangeOrder: (order: TriageSurfaceStateV1['order']) => void;
  onChangeSmartPolicy: (smartPolicy: CorpusSmartPolicyV1) => void;
}>): NonNullable<NonNullable<CollectionToolbarProps['refine']>['foldedChoices']> {
  const { order, smartPolicy, text } = props;
  const orderLabel = text('plugins.triage.surface.order', 'Order');
  const smartLabel = text('plugins.triage.surface.smartPolicy', 'Smart order');
  const groups: MenuGroup[] = [
    {
      id: 'order',
      accessibilityLabel: orderLabel,
      items: readTriageOrderOptionsV1(text).map(({ key, label }) => ({
        id: `${ORDER_ROW_PREFIX}${key}`, label, kind: 'radio' as const, radioGroupId: 'order',
      })),
    },
    ...(order === 'smart' ? [{
      id: 'smart',
      accessibilityLabel: smartLabel,
      items: SMART_PRECEDENCE_COPY.map(([value, key, fallback]) => ({
        id: `${SMART_ROW_PREFIX}${value}`, label: text(key, fallback), kind: 'radio' as const, radioGroupId: 'smart',
      })),
    }] : []),
  ];
  return {
    groups,
    radioGroups: [
      { id: 'order', accessibilityLabel: orderLabel, selectedId: `${ORDER_ROW_PREFIX}${order}` },
      ...(order === 'smart'
        ? [{ id: 'smart', accessibilityLabel: smartLabel, selectedId: `${SMART_ROW_PREFIX}${smartPolicy.precedence[0]}` }]
        : []),
    ],
    onSelect: (id) => {
      const match = ORDER_COPY.find(([candidate]) => `${ORDER_ROW_PREFIX}${candidate}` === id);
      if (match !== undefined) { props.onChangeOrder(match[0]); return; }
      const tuple = CORPUS_SMART_PRECEDENCE_TUPLES_V1.find((candidate) => `${SMART_ROW_PREFIX}${candidate[0]}` === id);
      if (tuple !== undefined) props.onChangeSmartPolicy({ v: 1, precedence: tuple });
    },
  };
}

/**
 * The folded editor's one way back to the list, saying what it shows. Coverage is the window owner's fact, including
 * a cold/unavailable window: filtering never turns a loaded subset into an authoritative total.
 */
export function readTriageFilterDoneLabelV1(props: Readonly<{
  text: TriageTextResolverV1;
  resultCount: number;
  windowState: TriageListShellStateV1;
}>): string {
  const { text } = props;
  return props.windowState.kind === 'initial'
    ? text('plugins.triage.surface.filters.showUnsynchronized', 'Show results · Not yet synchronized')
    : props.windowState.kind === 'unavailable' || props.windowState.kind === 'sourcesUnreachable'
      ? text('plugins.triage.surface.filters.showUnavailable', 'Show results · Unavailable')
      : props.windowState.kind === 'window' && props.windowState.window.coverage !== 'complete'
        ? props.resultCount === 1
          ? text('plugins.triage.surface.filters.showPartialResult', 'Show 1 result so far')
          : text('plugins.triage.surface.filters.showPartialResults', 'Show {count} results so far').replace('{count}', String(props.resultCount))
        : props.resultCount === 1
          ? text('plugins.triage.surface.filters.showResult', 'Show 1 result')
          : text('plugins.triage.surface.filters.showResults', 'Show {count} results').replace('{count}', String(props.resultCount));
}

/**
 * The facets as the shared condition editor's model: one `set` field per facet ("State is Open or Done"), its
 * options keyed by the plan's opaque option key, so an edit maps back to the planned facet value and nothing is
 * parsed out of a key. A facet's notice (its scopes could not be read) stays a disabled choice under that field.
 */
export function readTriageFilterConditionModelV1(facets: readonly TriageFilterFacetPlanV1[]): CollectionConditionModel {
  const shown = facets.filter((facet) => facet.options.length > 0 || (facet.notices?.length ?? 0) > 0);
  const fields = shown.map((facet) => ({
    id: facet.facet,
    label: facet.label,
    kind: 'set' as const,
    operators: ['is' as const],
    valueOptions: [
      ...facet.options.map((option) => ({ value: option.key, label: option.label })),
      ...(facet.notices ?? []).map((label, index) => ({ value: `${facet.facet}:notice:${index}`, label, disabled: true })),
    ],
  }));
  return {
    availableFields: fields,
    rows: fields.flatMap((field) => {
      const facet = shown.find((candidate) => candidate.facet === field.id)!;
      const values = facet.options.filter((option) => option.selected).map((option) => option.key);
      return values.length === 0 ? [] : [{
        id: JSON.stringify([field.id, 'is']), fieldId: field.id, field, operator: 'is' as const, values, available: true,
      }];
    }),
  };
}

/** One editor edit as the reducer actions it means: the option values it adds or drops, a facet emptied, or all. */
function applyTriageFilterEdit(
  facets: readonly TriageFilterFacetPlanV1[],
  edit: CollectionConditionEdit,
  actions: Pick<TriageFilterRailPropsV1, 'onToggleFilterValue' | 'onClearFacet' | 'onClearFilters'>,
): void {
  if (edit.type === 'clear') { actions.onClearFilters(); return; }
  if (edit.type === 'remove') {
    const facet = facets.find((candidate) => JSON.stringify([candidate.facet, 'is']) === edit.rowId);
    if (facet !== undefined) actions.onClearFacet(facet.facet);
    return;
  }
  const facet = facets.find((candidate) => candidate.facet === edit.condition.fieldId);
  if (facet === undefined) return;
  const wanted = new Set(edit.condition.values.filter((value): value is string => typeof value === 'string'));
  for (const option of facet.options) {
    if (option.selected !== wanted.has(option.key)) actions.onToggleFilterValue(option.selection);
  }
}

function readTriageConditionLabelsV1(text: TriageTextResolverV1): HappierCollectionConditionEditorLabels {
  return {
    title: text('plugins.triage.surface.filters.condition.title', 'Filter'),
    clear: text('plugins.triage.surface.filters.condition.clear', 'Clear'),
    add: text('plugins.triage.surface.filters.condition.add', 'Add filter'),
    addSearch: text('plugins.triage.surface.filters.condition.addSearch', 'Filter by…'),
    back: text('plugins.triage.surface.filters.condition.back', 'Back'),
    or: text('plugins.triage.surface.filters.condition.or', 'or'),
    operators: {
      is: text('plugins.triage.surface.filters.condition.is', 'is'),
      is_not: text('plugins.triage.surface.filters.condition.isNot', 'isn\u2019t'),
      before: text('plugins.triage.surface.filters.condition.before', 'before'),
      after: text('plugins.triage.surface.filters.condition.after', 'after'),
      between: text('plugins.triage.surface.filters.condition.between', 'between'),
      unavailable: text('plugins.triage.surface.filters.condition.unavailable', 'unavailable'),
    },
    remove: (field) => text('plugins.triage.surface.filters.condition.remove', 'Remove {field}').replace('{field}', field),
    count: (count) => (count === 1 ? text('plugins.triage.surface.filters.condition.countOne', '1 item')
      : text('plugins.triage.surface.filters.condition.count', '{count} items').replace('{count}', String(count))),
    countPartial: (count) => text('plugins.triage.surface.filters.condition.countPartial', '{count} loaded \u00b7 more may match')
      .replace('{count}', String(count)),
    saveAsSpace: text('plugins.triage.surface.filters.condition.saveAsView', 'Save as view'),
    done: text('plugins.triage.surface.filters.condition.done', 'Done'),
    noFields: text('plugins.triage.surface.filters.condition.noFields', 'Every filter is in use'),
    noValues: text('plugins.triage.surface.filters.condition.noValues', 'No filters available'),
  };
}

/** The editor's own width (lab `clfilter:filter`), the same as Sessions' and Workflows' filter popover. */
const conditionEditorFrameStyle = { width: HAPPIER_COLLECTION_CONDITION_EDITOR_METRICS.width, maxWidth: '100%' } as const;

type TriageFilterEditorPropsV1 = Readonly<{
  facets: readonly TriageFilterFacetPlanV1[];
  text: TriageTextResolverV1;
  onToggleFilterValue: (selection: TriageFilterFacetValueV1) => void;
  onClearFacet: (facet: TriageFilterFacetPlanV1['facet']) => void;
  onClearFilters: () => void;
  result: EntityListFilterResultV1 | undefined;
}>;

/**
 * The one filter form (`CollectionConditionEditor`, the editor Sessions and Workflows use): what narrows the list as
 * "Field is value" rows, Add filter for another facet, Clear. The wide Filters popover and the folded sheet both draw
 * this, so there is one filter UI at every width.
 */
function TriageFilterEditor(props: TriageFilterEditorPropsV1 & Readonly<{
  done?: Readonly<{ label: string; onPress: () => void }>;
  maxHeight?: number;
}>): React.ReactElement {
  const { facets, onClearFacet, onClearFilters, onToggleFilterValue, result, text } = props;
  const model = React.useMemo(() => readTriageFilterConditionModelV1(facets), [facets]);
  const labels = React.useMemo(() => readTriageConditionLabelsV1(text), [text]);
  const onChange = React.useCallback((edit: CollectionConditionEdit) => {
    applyTriageFilterEdit(facets, edit, { onToggleFilterValue, onClearFacet, onClearFilters });
  }, [facets, onClearFacet, onClearFilters, onToggleFilterValue]);
  return (
    <CollectionConditionEditor model={model} labels={labels} onChange={onChange}
      {...(result === undefined ? {} : { result })}
      {...(props.done === undefined ? {} : { onDone: props.done.onPress, doneLabel: props.done.label })}
      {...(props.maxHeight === undefined ? {} : { maxHeight: props.maxHeight })} />
  );
}

/**
 * The folded toolbar's Filters (`CollectionToolbar` `refine.sheet`): the same editor in the shared sheet, which it
 * titles itself ("Filter · Clear"), finished by the one primary that says what the list now shows. Anchored (a desktop
 * row that folded), it keeps the popover's editor width.
 */
export function TriageFilterSheet(props: TriageFilterEditorPropsV1 & Readonly<{
  controls: SheetMenuContentControls;
  doneLabel: string;
}>): React.ReactElement {
  const { controls, doneLabel, ...editor } = props;
  // The one way back says what the list now shows ("Show 9 results"), so the editor's own count is not said again.
  const body = <TriageFilterEditor {...editor} result={undefined} done={{ label: doneLabel, onPress: controls.close }}
    maxHeight={controls.maxHeight} />;
  return controls.sheet ? body : <View style={conditionEditorFrameStyle}>{body}</View>;
}

/**
 * The lens on a wide row: one **Filters** trigger opening the shared editor in the public `Popover`. Every selected
 * constraint also stays named and removable as a token in the list's search field (the shell's `searchTokens`). The
 * Popover owns the overlay's layer, focus and dismissal.
 */
function TriageCompactFilters(props: TriageFilterEditorPropsV1): React.ReactElement {
  const { facets, text } = props;
  const [open, setOpen] = React.useState(false);
  const label = text('plugins.triage.surface.filters', 'Filters');
  const activeCount = facets.reduce(
    (count, facet) => count + facet.options.filter((option) => option.selected).length,
    0,
  );
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={activeCount === 0 ? label : `${label} · ${activeCount}`}
      // Quiet words that open the editor (lab: the lens is said in the search, not by filled pills).
      triggerDisclosure
      triggerAccessibilityLabel={label}
      contentAccessibilityLabel={text('plugins.triage.surface.filters.condition.title', 'Filter')}
      floatingRole="panel"
      placement="bottom"
    >
      <View style={conditionEditorFrameStyle}>
        <TriageFilterEditor {...props} />
      </View>
    </Popover>
  );
}

/**
 * Whether the Collection's table states the order in its title column ("Task · Newest"). Order then has that one
 * home, so neither the wide row nor the folded ⋯ offers it a second time.
 */
export function TriageOrderPlacement(props: Readonly<{ children: (orderedByTable: boolean) => React.ReactElement }>): React.ReactElement {
  return props.children(useHappierCollectionLayout()?.composition === 'table');
}

export function TriageFilterRail(props: TriageFilterRailPropsV1): React.ReactElement {
  const layout = useHappierCollectionLayout();
  const {
    facets,
    onChangeOrder,
    onChangeSmartPolicy,
    onClearFacet,
    onClearFilters,
    onToggleFilterValue,
    order,
    smartPolicy,
    text,
  } = props;

  const onOrderChange = React.useCallback((value: unknown) => {
    const match = ORDER_COPY.find(([candidate]) => candidate === value);
    if (match !== undefined) onChangeOrder(match[0]);
  }, [onChangeOrder]);

  const onPrecedenceChange = React.useCallback((value: unknown) => {
    const tuple = CORPUS_SMART_PRECEDENCE_TUPLES_V1.find((candidate) => candidate[0] === value);
    if (tuple !== undefined) onChangeSmartPolicy({ v: 1, precedence: tuple });
  }, [onChangeSmartPolicy]);

  return (
    <>
      <TriageCompactFilters
        facets={facets}
        text={text}
        onToggleFilterValue={onToggleFilterValue}
        onClearFacet={onClearFacet}
        onClearFilters={onClearFilters}
        result={props.result}
      />
      {layout?.composition !== 'table' ? <Select
        label={text('plugins.triage.surface.order', 'Order')}
        presentation="menu"
        value={order}
        options={readTriageOrderOptionsV1(text).map(({ key, label }) => ({ value: key, label }))}
        onChange={onOrderChange}
      /> : null}
      {/*
        Only beside Smart. The precedence is retained across an order change so
        the preference survives, but a control that visibly reorders nothing is
        a control that lies about what it does.
      */}
      {order === 'smart' ? (
        <Select
          label={text('plugins.triage.surface.smartPolicy', 'Smart order')}
          presentation="menu"
          value={smartPolicy.precedence[0]}
          options={SMART_PRECEDENCE_COPY.map(([value, key, fallback]) => ({
            value,
            label: text(key, fallback),
          }))}
          onChange={onPrecedenceChange}
        />
      ) : null}
    </>
  );
}
