import { Fragment, createElement, type ReactNode } from 'react';

import { View } from 'react-native';

import { HAPPIER_COLLECTION_ROW_METRICS } from '../collection/CollectionRowContent.js';
import type { HappierCapabilityFactsInput } from './capabilityFacts.js';
import {
  doesHappierCapabilityStatusSpeak,
  type HappierCapabilityStatus,
} from './capabilityStatus.js';

export type HappierCapabilityCollectionAnatomyInput<Item> = Readonly<{
  title: (item: Item) => string;
  description: (item: Item) => string | null;
  /** Where it is on ("Everywhere", "2 projects"), at the title line's end and never truncated. */
  whereSummary?: (item: Item) => ReactNode;
  /** A quiet count on the title line, leaving the description its own line. */
  count?: (item: Item) => number | string | null | undefined;
  /** Supplied only for mixed-kind collections. */
  kindLabel?: (item: Item) => string | null;
  facts: (item: Item) => HappierCapabilityFactsInput;
  status?: (item: Item) => HappierCapabilityStatus | null;
  /** The item's identity mark or kind glyph, centred in the catalog mark box; omit only for a kind with neither. */
  mark?: (item: Item) => ReactNode;
  action?: (item: Item) => ReactNode;
  accessibilityLabel: (item: Item) => string;
  testID: (item: Item) => string;
}>;

/** How the caller draws each part with its own primitives. */
export type HappierCapabilityCollectionAnatomyParts = Readonly<{
  facts: (facts: HappierCapabilityFactsInput) => ReactNode;
  status: (status: HappierCapabilityStatus, testID: string) => ReactNode;
  /** A plain-text where-summary as quiet tabular meta. */
  summary: (text: string) => ReactNode;
  /** The status's independent fix; never part of the row's open/check target. */
  fix?: (status: HappierCapabilityStatus, testID: string) => ReactNode;
}>;

/** Structurally the public `Collection`'s anatomy for a capability list. */
export type HappierCapabilityCollectionAnatomy<Item> = Readonly<{
  rowRole: 'catalogRow';
  glyph: (item: Item) => ReactNode;
  loadingGlyph: boolean;
  title: (item: Item) => string;
  description: (item: Item, layout?: Readonly<{ narrow: boolean }>) => string | null;
  titleMeta?: (item: Item) => ReactNode;
  kindLabel?: (item: Item) => string | null;
  byline: (item: Item) => ReactNode;
  reason: (item: Item) => ReactNode;
  action?: (item: Item) => ReactNode;
  accessibilityLabel: (item: Item) => string;
  testID: (item: Item) => string;
  columnTitles: Readonly<{ title: string }>;
}>;

/**
 * The capability row anatomy for the public `Collection` (an add dialog's list, a homepage shelf, a plugin's
 * installable things): name and held count/scope, then the canonical status and description. Facts remain
 * available to cards/detail. Kinds without a mark draw no glyph column.
 */
const FIX_AND_ACTION_STYLE = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: HAPPIER_COLLECTION_ROW_METRICS.trailingGap,
} as const;

export function buildHappierCapabilityCollectionAnatomy<Item>(
  input: HappierCapabilityCollectionAnatomyInput<Item>,
  parts: HappierCapabilityCollectionAnatomyParts,
): HappierCapabilityCollectionAnatomy<Item> {
  const whereSummary = input.whereSummary;
  const speakingStatus = (item: Item) => {
    const status = input.status?.(item) ?? null;
    return status !== null && doesHappierCapabilityStatusSpeak(status, 'row') ? status : null;
  };
  return {
    rowRole: 'catalogRow',
    glyph: (item) => input.mark?.(item) ?? null,
    loadingGlyph: input.mark !== undefined,
    title: input.title,
    description: (item, layout) => layout?.narrow && parts.fix !== undefined && speakingStatus(item)?.fix
      ? null : input.description(item),
    ...(input.kindLabel === undefined ? {} : { kindLabel: input.kindLabel }),
    ...(whereSummary === undefined && input.count === undefined
      ? {}
      : {
          titleMeta: (item: Item) => {
            const summary = whereSummary?.(item);
            const where = typeof summary === 'string'
              ? parts.summary(summary)
              : summary;
            const count = input.count?.(item);
            return count === undefined || count === null || count === '' ? where : createElement(
              Fragment, null, parts.summary(String(count)), where,
            );
          },
        }),
    byline: (item) => parts.facts(input.facts(item)),
    reason: (item) => {
      const status = speakingStatus(item);
      return status !== null
        ? parts.status(status, `${input.testID(item)}:status`)
        : null;
    },
    ...(input.action === undefined && parts.fix === undefined ? {} : {
      action: (item: Item) => {
        const status = speakingStatus(item);
        const fix = status?.fix
          ? parts.fix?.(status, `${input.testID(item)}:status:fix`) ?? null
          : null;
        const action = input.action?.(item) ?? null;
        // The fix and the row's own control share one line at the row's end, never stacked over each other.
        return fix === null ? action : action === null ? fix : createElement(View, { style: FIX_AND_ACTION_STYLE }, fix, action);
      },
    }),
    accessibilityLabel: input.accessibilityLabel,
    testID: input.testID,
    columnTitles: { title: '' },
  };
}
