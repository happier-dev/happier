import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '../actions/externalActionLimits.js';
import { measureSerializedValidatedStrictPluginJsonUtf8Bytes } from '../plugins/contributions/strictJsonValue.js';
import { USAGE_QUERY_EVIDENCE_SECTIONS, type UsageQueryBatchResult, type UsageQueryResultSlice } from './resolveUsagePageAggregation.js';

type EvidenceSection = NonNullable<UsageQueryResultSlice['incomplete']>['omittedSections'][number];
const bytes = (value: unknown) => measureSerializedValidatedStrictPluginJsonUtf8Bytes(value, 'usageQueryDelivery');

function projectAccounting(value: NonNullable<UsageQueryResultSlice['accounting']>, includeRows: boolean): NonNullable<UsageQueryResultSlice['accounting']> {
  const { priceCatalog: _catalog, contributions, ...facts } = value;
  // Work conserves these exact rows. Summary/comparison facts do not need them.
  return includeRows && contributions !== undefined ? { ...facts, contributions } : facts;
}

function omitEvidence(slice: UsageQueryResultSlice, section: EvidenceSection): UsageQueryResultSlice {
  const incomplete = { reason: 'response_size_limit' as const, recovery: 'narrow_query' as const,
    omittedSections: [...(slice.incomplete?.omittedSections ?? []), section] };
  if (section === 'work') {
    const { work: _work, mergedOutcomes: _merged, ...facts } = slice;
    return { ...facts, ...(slice.accounting ? { accounting: projectAccounting(slice.accounting, false) } : {}), incomplete };
  }
  if (section === 'howYouWork') {
    const { howYouWork: _detail, ...facts } = slice;
    return { ...facts, incomplete };
  }
  if (section === 'coach') {
    const { coach: _coach, ...facts } = slice;
    return { ...facts, incomplete };
  }
  const unreachable: never = section;
  return unreachable;
}

/** Keep exact framing while each potentially omitted body is measured separately once. */
function projectMeasurementSkeleton(slice: UsageQueryResultSlice): unknown {
  return { ...slice,
    ...(slice.work === undefined ? {} : { work: null,
      ...(slice.mergedOutcomes === undefined ? {} : { mergedOutcomes: null }),
      ...(slice.accounting?.contributions === undefined ? {} : {
        accounting: { ...slice.accounting, contributions: null },
      }),
    }),
    ...(slice.howYouWork === undefined ? {} : { howYouWork: null }),
    ...(slice.coach === undefined ? {} : { coach: null }),
  };
}

/**
 * Action read projection, not a transport fallback. Keep the rich admitted read
 * for Resources/exports. Only evidence that cannot fit the existing complete
 * Action envelope is omitted, explicitly, with caller-driven narrower recovery.
 */
export function projectUsageQueryDelivery(batch: UsageQueryBatchResult): UsageQueryBatchResult {
  const result = { ...batch, results: batch.results.map(slice => ({ ...slice,
    ...(slice.accounting ? { accounting: projectAccounting(slice.accounting, slice.work !== undefined) } : {}),
    ...(slice.comparison?.accounting ? { comparison: { ...slice.comparison,
      accounting: projectAccounting(slice.comparison.accounting, false) } } : {}),
  })) };
  // Remove largest detail sections first so a large slice cannot erase a small
  // sibling's evidence. Work includes its conservation-dependent inputs/summary.
  const candidates = result.results.flatMap((slice, index) => USAGE_QUERY_EVIDENCE_SECTIONS.flatMap(section => {
    if (slice[section] === undefined) return [];
    const size = bytes(section === 'work'
      ? { work: slice.work, mergedOutcomes: slice.mergedOutcomes, contributions: slice.accounting?.contributions }
      : slice[section]);
    const skeletonSize = bytes(section === 'work' ? { work: null,
      mergedOutcomes: slice.mergedOutcomes === undefined ? undefined : null,
      contributions: slice.accounting?.contributions === undefined ? undefined : null,
    } : null);
    return [{ index, section, size, bodyBytes: size - skeletonSize }];
  })).sort((left, right) => right.size - left.size);
  let serializedBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1({ ...result,
    results: result.results.map(projectMeasurementSkeleton),
  }) + candidates.reduce((sum, candidate) => sum + candidate.bodyBytes, 0);
  if (serializedBytes <= EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) return result;
  for (const { index, section, bodyBytes } of candidates) {
    const previous = result.results[index]!;
    const next = omitEvidence(previous, section);
    // Only framing changes after admission; never rewalk an evidence body for
    // candidate ranking or an omission's exact byte delta.
    serializedBytes += bytes(projectMeasurementSkeleton(next)) - bytes(projectMeasurementSkeleton(previous)) - bodyBytes;
    result.results[index] = next;
    if (serializedBytes <= EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) break;
  }
  // If summary facts alone exceed the envelope, the existing transport owner
  // still refuses it. No cap bypass, fabricated zero, or silent truncation.
  return result;
}
