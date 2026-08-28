import { isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/plugin-sdk/actions';

export type FittedActionResultSequenceV1<TResult> = Readonly<{ result: TResult; includedCount: number }>;

export type FittedActionResultPageV1<TResult> = Readonly<{
  result: TResult;
  includedCount: number;
  continuationIncluded: boolean;
}>;

export function fitActionResultSequenceV1<TItem, TResult>(
  items: readonly TItem[],
  project: (items: readonly TItem[], omittedCount: number) => TResult,
): FittedActionResultSequenceV1<TResult> {
  const complete = project(items, 0);
  if (isExternalActionResultWithinResponseEnvelopeLimitV1(complete)) {
    return Object.freeze({ result: complete, includedCount: items.length });
  }
  let low = 0;
  let high = items.length;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    const projected = project(items.slice(0, candidate), items.length - candidate);
    if (isExternalActionResultWithinResponseEnvelopeLimitV1(projected)) low = candidate;
    else high = candidate - 1;
  }
  const result = project(items.slice(0, low), items.length - low);
  if (!isExternalActionResultWithinResponseEnvelopeLimitV1(result)) {
    throw new RangeError('action_result_base_exceeds_serialized_boundary');
  }
  return Object.freeze({ result, includedCount: low });
}

/**
 * Fits a provider page against the canonical external-Action response envelope.
 *
 * A continuation is provider-owned opaque paging state, not row content. When
 * the continuation makes even the empty-row result exceed the envelope, the
 * page is re-fitted without it and the projector must publish its own explicit
 * continuation-omission evidence. Other base-shape overflows still throw: this
 * helper does not silently discard arbitrary result members.
 */
export function fitActionResultPageV1<TItem, TContinuation, TResult>(
  items: readonly TItem[],
  continuation: TContinuation | undefined,
  project: (
    items: readonly TItem[],
    omittedCount: number,
    continuation: TContinuation | undefined,
    continuationOmitted: boolean,
  ) => TResult,
): FittedActionResultPageV1<TResult> {
  const continuationBaseFits = continuation === undefined
    || isExternalActionResultWithinResponseEnvelopeLimitV1(project(
      [],
      items.length,
      continuation,
      false,
    ));
  if (continuationBaseFits) {
    const fitted = fitActionResultSequenceV1(items, (included, omittedCount) => project(
      included,
      omittedCount,
      continuation,
      false,
    ));
    return Object.freeze({
      ...fitted,
      continuationIncluded: continuation !== undefined,
    });
  }

  const fitted = fitActionResultSequenceV1(items, (included, omittedCount) => project(
    included,
    omittedCount,
    undefined,
    true,
  ));
  return Object.freeze({ ...fitted, continuationIncluded: false });
}
