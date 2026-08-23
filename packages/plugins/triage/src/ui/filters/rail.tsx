import * as React from 'react';
import { Button, Popover, Row, Select, Stack, usePluginTranslation } from '@happier-dev/plugin-ui';

import {
  CORPUS_SMART_PRECEDENCE_TUPLES_V1,
  type CorpusSmartPolicyV1,
} from '../../corpus/query/smartPolicy.js';
import type { TriageFilterFacetValueV1, TriageSurfaceStateV1 } from '../state/surface.js';
import type { TriageTextResolverV1 } from '../shell/windowState.js';
import type { TriageFilterFacetPlanV1, TriageFilterOptionV1 } from './plan.js';

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
 * **Both §6 compositions live here, chosen by one fact the caller passes in.**
 * Wide exposes the five facet controls individually. Compact folds exactly
 * those five into one labelled **Filters** trigger presented by the public
 * `Popover`, so the portal, the initial focus, dismissal, focus return, Escape
 * and Android Back are the host's — Triage supplies one grouped five-facet form
 * and nothing else. `compact` is not measured here and is not a breakpoint:
 * `ui/shell/root.tsx` reads it off the one fill-region measurement
 * `ui/shell/layout.ts` already resolves the split composition from, so the page
 * has one width authority rather than two.
 *
 * **Chips exist only in the compact arm, and that is not a preference.** §6
 * asks for removable chips "outside the overlay" because the compact
 * composition hides the selected constraints behind a trigger, leaving a
 * narrowed list with no visible cause. With the facets exposed each control
 * already shows and removes its own selected values, so a chip row beside them
 * would state the same constraint twice and give the reader two places to
 * remove one thing.
 *
 * **Views and Order are never folded in.** They are separate lens questions —
 * which saved lens this is, and which ladder ranks it — and a reader who has to
 * open a Filters overlay to reorder the list has lost both.
 */

export type TriageFilterRailPropsV1 = Readonly<{
  facets: readonly TriageFilterFacetPlanV1[];
  /**
   * Whether the measured fill region cannot carry the five facet controls
   * individually (`core/SURFACE.md` §2.1, §6).
   *
   * The shell derives it from its own measurement; nothing here measures, asks
   * the platform how big a device is, or keeps a breakpoint of its own.
   */
  compact: boolean;
  order: TriageSurfaceStateV1['order'];
  smartPolicy: CorpusSmartPolicyV1;
  /**
   * Whether any FACET is selected — not whether the window is narrowed. It
   * decides only whether **Clear filters** is offered, and that control clears
   * facets: a route-carried query narrows the list too, but a button that says
   * it clears filters and leaves the query would be a control that does
   * nothing.
   */
  filtered: boolean;
  text: TriageTextResolverV1;
  onToggleFilterValue: (selection: TriageFilterFacetValueV1) => void;
  onClearFilters: () => void;
  onChangeOrder: (order: TriageSurfaceStateV1['order']) => void;
  onChangeSmartPolicy: (smartPolicy: CorpusSmartPolicyV1) => void;
}>;

const ORDER_COPY: readonly (readonly [TriageSurfaceStateV1['order'], string, string])[] = [
  ['newest', 'plugins.triage.surface.order.newest', 'Newest'],
  ['oldest', 'plugins.triage.surface.order.oldest', 'Oldest'],
  ['smart', 'plugins.triage.surface.order.smart', 'Smart'],
];

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

/**
 * Which value one press changed.
 *
 * The public multi-select control reports the whole next selection, while the
 * reducer owns the toggle so that "one facet never weakens another" has one
 * enforcement point. The difference between the two selections is therefore
 * read here and handed back as facet values — never as a replacement selection,
 * which would make this file a second filter authority.
 */
function toggledKeys(
  selected: readonly string[],
  next: readonly (string | Readonly<unknown>)[],
): readonly string[] {
  const nextKeys = next.filter((value): value is string => typeof value === 'string');
  const before = new Set(selected);
  const after = new Set(nextKeys);
  return [
    ...nextKeys.filter((key) => !before.has(key)),
    ...selected.filter((key) => !after.has(key)),
  ];
}

function TriageFilterFacetControl(props: Readonly<{
  facet: TriageFilterFacetPlanV1;
  onToggleFilterValue: (selection: TriageFilterFacetValueV1) => void;
}>): React.ReactElement | null {
  const { facet, onToggleFilterValue } = props;
  const selected = React.useMemo(
    () => facet.options.filter((option) => option.selected).map((option) => option.key),
    [facet.options],
  );
  const onChange = React.useCallback((value: unknown) => {
    const next = Array.isArray(value) ? value : [value];
    for (const key of toggledKeys(selected, next as readonly string[])) {
      const option = facet.options.find((candidate) => candidate.key === key);
      // Nothing is parsed back out of a key: the plan carries the exact facet
      // value beside it, so one press can only ever name the value it planned.
      if (option !== undefined) onToggleFilterValue(option.selection);
    }
  }, [facet.options, onToggleFilterValue, selected]);

  // A facet with nothing to offer renders nothing rather than an empty control
  // the reader can focus and not use.
  if (facet.options.length === 0) return null;
  return (
    <Select
      label={facet.label}
      multiple
      value={selected}
      options={facet.options.map((option) => ({ value: option.key, label: option.label }))}
      onChange={onChange}
    />
  );
}

/**
 * One selected constraint, named and removable outside the overlay.
 *
 * The visible label qualifies the value with its facet, because two chips
 * reading `Open` and `example/repository` say nothing about what each one
 * constrains — the same "one name or the qualified one" rule `filters/plan.ts`
 * applies to a value whose sources collide. `: ` is the punctuation the label
 * and the value are joined with, not copy.
 *
 * `{label}` interpolation is why the accessible name cannot go through
 * `accessibilityLabelKey`: that resolves through `resolveAuthorText` WITHOUT a
 * values argument, so the placeholder would reach the reader verbatim. It is
 * the same reason `ui/list/rows.tsx` resolves **Unpin {title}** through this
 * hook rather than through the control's own key prop.
 */
function TriageActiveFilterChip(props: Readonly<{
  facetLabel: string;
  option: TriageFilterOptionV1;
  onToggleFilterValue: (selection: TriageFilterFacetValueV1) => void;
}>): React.ReactElement {
  const { facetLabel, onToggleFilterValue, option } = props;
  const translate = usePluginTranslation();
  const label = `${facetLabel}: ${option.label}`;
  const onPress = React.useCallback(() => {
    onToggleFilterValue(option.selection);
  }, [onToggleFilterValue, option.selection]);
  return (
    <Button
      title={label}
      accessibilityLabel={translate(
        'plugins.triage.surface.filters.remove',
        'Remove filter {label}',
        { label },
      )}
      variant="secondary"
      onPress={onPress}
    />
  );
}

/**
 * The compact lens: one **Filters** trigger, and every selected constraint
 * beside it.
 *
 * The open state belongs to this component rather than to the rail, so a
 * region that grows back to the wide composition unmounts it and takes the
 * open state with it. A retained one would reopen the overlay by itself the
 * next time the reader narrowed the window.
 */
function TriageCompactFilters(props: Readonly<{
  facets: readonly TriageFilterFacetPlanV1[];
  text: TriageTextResolverV1;
  onToggleFilterValue: (selection: TriageFilterFacetValueV1) => void;
}>): React.ReactElement {
  const { facets, onToggleFilterValue, text } = props;
  const [open, setOpen] = React.useState(false);
  const label = text('plugins.triage.surface.filters', 'Filters');
  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger={label}
        triggerAccessibilityLabel={label}
      >
        {/*
          One grouped form, and only the five facets. The overlay's layer,
          focus and dismissal are the host's; this is the content it presents.
        */}
        <Stack gap="small">
          {facets.map((facet) => (
            <TriageFilterFacetControl
              key={facet.facet}
              facet={facet}
              onToggleFilterValue={onToggleFilterValue}
            />
          ))}
        </Stack>
      </Popover>
      {facets.flatMap((facet) => facet.options
        .filter((option) => option.selected)
        .map((option) => (
          <TriageActiveFilterChip
            key={option.key}
            facetLabel={facet.label}
            option={option}
            onToggleFilterValue={onToggleFilterValue}
          />
        )))}
    </>
  );
}

export function TriageFilterRail(props: TriageFilterRailPropsV1): React.ReactElement {
  const {
    compact,
    facets,
    filtered,
    onChangeOrder,
    onChangeSmartPolicy,
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
    <Row gap="small" wrap align="center">
      {/*
        Only the facet region has two arms. Order, Smart order and Clear
        filters are written once and wrap in render order beside whichever one
        is showing, because a second copy of them would be a second place they
        could drift.
      */}
      {compact ? (
        <TriageCompactFilters
          facets={facets}
          text={text}
          onToggleFilterValue={onToggleFilterValue}
        />
      ) : facets.map((facet) => (
        <TriageFilterFacetControl
          key={facet.facet}
          facet={facet}
          onToggleFilterValue={onToggleFilterValue}
        />
      ))}
      <Select
        label={text('plugins.triage.surface.order', 'Order')}
        value={order}
        options={ORDER_COPY.map(([value, key, fallback]) => ({
          value,
          label: text(key, fallback),
        }))}
        onChange={onOrderChange}
      />
      {/*
        Only beside Smart. The precedence is retained across an order change so
        the preference survives, but a control that visibly reorders nothing is
        a control that lies about what it does.
      */}
      {order === 'smart' ? (
        <Select
          label={text('plugins.triage.surface.smartPolicy', 'Smart order')}
          value={smartPolicy.precedence[0]}
          options={SMART_PRECEDENCE_COPY.map(([value, key, fallback]) => ({
            value,
            label: text(key, fallback),
          }))}
          onChange={onPrecedenceChange}
        />
      ) : null}
      {filtered ? (
        <Button
          titleKey="plugins.triage.surface.filters.clear"
          title="Clear filters"
          variant="plain"
          onPress={onClearFilters}
        />
      ) : null}
    </Row>
  );
}
