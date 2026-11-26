import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '../actions/externalActionLimits.js';
import { measureSerializedValidatedStrictPluginJsonUtf8Bytes } from '../plugins/contributions/strictJsonValue.js';
import { type UsageQueryBatchResult, type UsageQueryResultSlice } from './resolveUsagePageAggregation.js';

type EvidenceSection = NonNullable<UsageQueryResultSlice['incomplete']>['omittedSections'][number];
type EvidenceOmission = { index: number; section: EvidenceSection; bodyBytes: number };
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
    omittedSections: [
      ...(slice.incomplete?.omittedSections ?? []).filter(previous => section !== 'work' || previous !== 'workSessionDetail'),
      section,
    ] };
  if (section === 'workSessionDetail' && slice.work) {
    return { ...slice, work: { ...slice.work, allocations: [], branchAllocations: [] },
      ...(slice.accounting ? { accounting: projectAccounting(slice.accounting, false) } : {}), incomplete };
  }
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
  throw new Error(`Cannot omit Usage evidence section: ${section}`);
}

/** Keep exact framing while each potentially omitted body is measured separately once. */
function projectMeasurementSkeleton(slice: UsageQueryResultSlice): unknown {
  return { ...slice,
    ...(slice.work === undefined ? {} : {
      work: { allocations: null, branchAllocations: null, outcomes: null, branches: null },
      ...(slice.mergedOutcomes === undefined ? {} : { mergedOutcomes: null }),
      ...(slice.accounting?.contributions === undefined ? {} : {
        accounting: { ...slice.accounting, contributions: null },
      }),
    }),
    ...(slice.howYouWork === undefined ? {} : { howYouWork: null }),
    ...(slice.coach === undefined ? {} : { coach: null }),
  };
}

function applyOmission(slices: UsageQueryResultSlice[], { index, section, bodyBytes }: EvidenceOmission): number {
  const previous = slices[index]!;
  const next = omitEvidence(previous, section);
  slices[index] = next;
  return bytes(projectMeasurementSkeleton(next)) - bytes(projectMeasurementSkeleton(previous)) - bodyBytes;
}

function omitDetailUntilFit(
  slices: UsageQueryResultSlice[], detail: readonly EvidenceOmission[], serializedBytes: number,
): number {
  for (const omission of detail) {
    if (serializedBytes <= EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) break;
    if (omission.section === 'workSessionDetail' && !slices[omission.index]!.work) continue;
    serializedBytes += applyOmission(slices, omission);
  }
  return serializedBytes;
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
  const nullBytes = bytes(null);
  const emptyArrayBytes = bytes([]);
  const detail: EvidenceOmission[] = [];
  const links: (EvidenceOmission & { sessionBodyBytes: number })[] = [];
  let fullBodyBytes = 0;
  for (const [index, slice] of result.results.entries()) {
    const { work } = slice;
    if (work) {
      const contributionBytes = slice.accounting?.contributions === undefined
        ? 0 : bytes(slice.accounting.contributions) - nullBytes;
      const sessionBytes = bytes(work.allocations) + bytes(work.branchAllocations) - 2 * emptyArrayBytes + contributionBytes;
      const linkedBytes = bytes(work.outcomes) + bytes(work.branches) - 2 * nullBytes
        + 2 * (emptyArrayBytes - nullBytes)
        + (slice.mergedOutcomes === undefined ? 0 : bytes(slice.mergedOutcomes) - nullBytes);
      if (!slice.incomplete?.omittedSections.includes('workSessionDetail')) {
        detail.push({ index, section: 'workSessionDetail', bodyBytes: sessionBytes });
      }
      links.push({ index, section: 'work', bodyBytes: linkedBytes, sessionBodyBytes: sessionBytes });
      fullBodyBytes += sessionBytes + linkedBytes;
    }
    for (const section of ['howYouWork', 'coach'] as const) {
      if (slice[section] === undefined) continue;
      const bodyBytes = bytes(slice[section]) - nullBytes;
      detail.push({ index, section, bodyBytes });
      fullBodyBytes += bodyBytes;
    }
  }
  let serializedBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1({ ...result,
    results: result.results.map(projectMeasurementSkeleton),
  }) + fullBodyBytes;
  if (serializedBytes <= EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) return result;
  // Omit per-Session Work detail across the reply, largest first, before dropping any Work link list.
  detail.sort((a, b) => b.bodyBytes - a.bodyBytes);
  const compact = [...result.results];
  let compactBytes = omitDetailUntilFit(compact, detail, serializedBytes);
  if (compactBytes <= EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) return { ...result, results: compact };

  // If compact Work still cannot fit, drop the largest linked body from both
  // projections. Spend optional omissions only against the surviving linked
  // rows. The original projection can keep a small sibling's complete answer.
  for (const omission of links.sort((a, b) => b.bodyBytes - a.bodyBytes)) {
    compactBytes += applyOmission(compact, omission);
    serializedBytes += applyOmission(result.results, { ...omission, bodyBytes: omission.bodyBytes + omission.sessionBodyBytes });
    if (compactBytes <= EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) {
      omitDetailUntilFit(result.results, detail, serializedBytes);
      return result;
    }
  }
  // If summary facts alone exceed the envelope, the existing transport owner
  // still refuses it. No cap bypass, fabricated zero, or silent truncation.
  return { ...result, results: compact };
}
