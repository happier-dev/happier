import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '../actions/externalActionLimits.js';
import { measureSerializedValidatedStrictPluginJsonUtf8Bytes } from '../plugins/contributions/strictJsonValue.js';
import { USAGE_QUERY_EVIDENCE_SECTIONS, type UsageQueryBatchResult, type UsageQueryResultSlice } from './resolveUsagePageAggregation.js';

type EvidenceSection = NonNullable<UsageQueryResultSlice['incomplete']>['omittedSections'][number];
const bytes = (value: unknown) => measureSerializedValidatedStrictPluginJsonUtf8Bytes(value, 'usageQueryDelivery');
type Accounting = NonNullable<UsageQueryResultSlice['accounting']>;
type SourceGroup = NonNullable<NonNullable<Accounting['coverage']>['sourceSummary']>['groups'][number];

function projectAccounting(value: Accounting, includeRows: boolean, summaryDelivery = false): Accounting {
  const { priceCatalog: _catalog, contributions, sessionIds, sessionMembership, ...facts } = value;
  // These are Resource repricing/calendar operands, not additional Action facts.
  // A broad agent read needs the admitted totals, not a second copy of every
  // hourly cell and its tariff population. Selected Session reads retain detail.
  if (summaryDelivery && facts.summary) {
    const { pricing: _pricing, rankedPricing: _ranked, accountingCalendar: _calendar, ...summary } = facts.summary;
    facts.summary = summary;
  }
  const coverage = facts.coverage;
  if (summaryDelivery && coverage && !coverage.sourceSummary) {
    const groups = new Map<string, SourceGroup>();
    for (const row of coverage.sources) {
      const key = JSON.stringify([row.path, row.status, row.captureKind]);
      const group = groups.get(key);
      if (group) {
        group.sourceCount++;
        group.eventCount += row.eventCount;
      } else {
        groups.set(key, { path: row.path, status: row.status,
          ...(row.captureKind === undefined ? {} : { captureKind: row.captureKind }),
          sourceCount: 1, eventCount: row.eventCount });
      }
    }
    facts.coverage = { ...coverage, sources: [], sourceSummary: {
      sourceCount: coverage.sources.length, groups: [...groups.values()],
    } };
  }
  // Work conserves these exact rows. Summary/comparison facts do not need them.
  return { ...facts,
    ...(!summaryDelivery && sessionIds !== undefined ? { sessionIds } : {}),
    ...(!summaryDelivery && sessionMembership !== undefined ? { sessionMembership } : {}),
    ...(includeRows && contributions !== undefined ? { contributions } : {}),
  };
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
 * Agent/MCP broad reads select summary delivery for their smaller tool budgets.
 */
export function projectUsageQueryDelivery(batch: UsageQueryBatchResult, surface?: 'agent' | 'mcp'): UsageQueryBatchResult {
  const result = { ...batch, results: batch.results.map(original => {
    let slice = original;
    const sessions = slice.requestedQuery.session;
    const summary = Boolean(surface) && !(typeof sessions === 'string' || sessions?.length === 1);
    // Agent tools have their own smaller delivery budgets (Pi: 50 KiB tool,
    // 1 MiB bridge). Broad reads deliver conserved summary facts, not event
    // bodies. One selected Session is the existing detail/recovery front door.
    if (summary) {
      for (const section of ['work', 'howYouWork'] as const) {
        if (slice[section] !== undefined) slice = omitEvidence(slice, section);
      }
    }
    return { ...slice,
      ...(slice.accounting ? { accounting: projectAccounting(slice.accounting, slice.work !== undefined, summary) } : {}),
      ...(slice.comparison?.accounting ? { comparison: { ...slice.comparison,
        accounting: projectAccounting(slice.comparison.accounting, false, summary) } } : {}),
    };
  }) };
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
