import type { WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { ReviewGetResponseV1Schema, type ReviewListItemV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { reviewStateLabel } from '@/components/reviews/list/reviewStateLabel';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { formatWorkflowFieldLabel } from './workflowValuePresentation';

/** One label/value line of a result read as words (lab `run-A_completed` Final output). */
export type WorkflowResultReadingRow = Readonly<{
  key: string;
  label: string;
  text: string;
}>;

type JsonObject = Readonly<Record<string, JsonValue>>;

function isObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

/**
 * A for-each item's or parallel branch's entry in its container's result: `{ index | branchId, status,
 * results: { <step>: value } }`. Its keys are execution bookkeeping, never something to show.
 */
function readContainerEntry(
  value: JsonValue,
): Readonly<{ label: string; results: JsonObject }> | null {
  if (
    !isObject(value) ||
    typeof value.status !== 'string' ||
    !isObject(value.results)
  )
    return null;
  if (typeof value.index === 'number')
    return {
      label: t('workflows.run.resultItem', { n: value.index + 1 }),
      results: value.results,
    };
  if (typeof value.branchId === 'string')
    return {
      label: formatWorkflowFieldLabel(value.branchId),
      results: value.results,
    };
  return null;
}

/** The keys a paged list carries beside its items: where the next page starts, never something to show. */
const PAGE_CURSOR_KEYS: ReadonlySet<string> = new Set(['cursor', 'nextCursor']);

/**
 * A paged list (`{ items, cursor }`, as list Actions answer) reads as its items: an empty page reads as an
 * empty list, and the cursor is pagination plumbing. Anything else reads as itself.
 */
function readListPage(value: JsonValue): JsonValue {
  if (!isObject(value) || !Array.isArray(value.items)) return value;
  return Object.keys(value).every((key) => key === 'items' || PAGE_CURSOR_KEYS.has(key))
    ? value.items
    : value;
}

/** A value as one line of words: names for keys, "Yes"/"No", items joined; never a serialization. */
export function readWorkflowValueText(input: JsonValue): string {
  const value = readListPage(input);
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return t(value ? 'common.yes' : 'common.no');
  if (value === null) return t('workflows.page.inspector.none');
  if (Array.isArray(value))
    return value.length === 0
      ? t('workflows.page.inspector.none')
      : value.map(readWorkflowValueText).join(', ');
  const entries = Object.entries(value);
  if (entries.length === 0) return t('workflows.page.inspector.none');
  return entries
    .map(
      ([name, nested]) =>
        `${formatWorkflowFieldLabel(name)}: ${readWorkflowValueText(nested)}`,
    )
    .join(' · ');
}

/** One step's answer reads as itself; several read as "Step: answer". */
function readResults(results: JsonObject): string {
  const entries = Object.entries(results);
  if (entries.length === 0) return t('workflows.page.inspector.none');
  if (entries.length === 1) return readWorkflowValueText(entries[0]![1]);
  return entries
    .map(
      ([step, answer]) =>
        `${formatWorkflowFieldLabel(step)}: ${readWorkflowValueText(answer)}`,
    )
    .join('\n');
}

function readReviewResultRows(review: ReviewListItemV1): readonly WorkflowResultReadingRow[] {
  const rows = [
    { key: 'state', label: formatWorkflowFieldLabel('state'), text: reviewStateLabel(review.state) },
    { key: 'round', label: formatWorkflowFieldLabel('round'), text: String(review.currentRoundOrdinal) },
    { key: 'findings', label: formatWorkflowFieldLabel('findings'),
      text: t('reviewWalkthrough.detail.findingsCount', { count: review.counts.total }) },
  ];
  for (const key of ['startedAt', 'finishedAt'] as const) {
    const timestamp = review[key];
    if (timestamp === null) continue;
    const text = formatWithCachedDateTimeFormatter(timestamp, getPreferredLanguage(), { dateStyle: 'medium', timeStyle: 'short' });
    rows.push({ key, label: formatWorkflowFieldLabel(key), text });
  }
  return rows;
}

/**
 * A structured result as label/value rows: an object by its fields, a list one row per item (a for-each
 * or parallel result by its item or branch). `null` for a scalar, which reads as itself. Field labels come
 * from the contract's titles first; the raw value stays available behind Copy.
 */
export function readWorkflowResultRows(
  input: JsonValue,
  fieldTitles?: Readonly<Record<string, string | undefined>>,
  blockKind?: WorkflowProgressEnvelopeV1['blockKind'],
): readonly WorkflowResultReadingRow[] | null {
  const value = readListPage(input);
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return value.map((item, position) => {
      const container = blockKind === 'loop' || blockKind === 'parallel' ? readContainerEntry(item) : null;
      return container !== null
        ? {
            key: String(position),
            label: container.label,
            text: readResults(container.results),
          }
        : {
            key: String(position),
            label: t('workflows.run.resultItem', { n: position + 1 }),
            text: readWorkflowValueText(item),
          };
    });
  }
  if (!isObject(value)) return null;
  if (value.review !== undefined && value.human !== undefined) {
    const review = ReviewGetResponseV1Schema.safeParse(value);
    if (review.success) return readReviewResultRows(review.data.review);
  }
  // Authored fields in declaration order, then any additional published values.
  const names = [
    ...new Set([...Object.keys(fieldTitles ?? {}), ...Object.keys(value)]),
  ].filter((name) => Object.hasOwn(value, name));
  if (names.length === 0) return null;
  return names.map((name) => ({
    key: name,
    label: fieldTitles?.[name] ?? formatWorkflowFieldLabel(name),
    text: readWorkflowValueText(value[name]!),
  }));
}
