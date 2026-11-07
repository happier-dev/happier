import {
  defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';
import {
  decodeTriagePagingTokenV1, encodeTriagePagingTokenV1,
  TriageScanContinuationV1Schema, TriageSourceScanEvidenceV1Schema,
  type TriageConfiguredSourceInstanceV1, type TriageScanInputV1, type TriageScanResultV1,
  type TriageSourceScopeSelectionV1, type TriageSourceScanEvidenceV1,
} from '@happier-dev/triage-protocol/v1';

import { deriveTriageConfiguredSourceInstanceDigestV1 } from '../authorization/configuredSourceCurrentness.js';

const frontierSchema = defineProtocolObject({
  v: defineProtocolLiteral(1), kind: defineProtocolLiteral('selected-scopes'),
  instanceDigest: defineProtocolString({ minLength: 1 }),
  index: defineProtocolNumber({ integer: true, minimum: 0 }),
  unitId: defineProtocolString({ minLength: 1 }),
  limit: defineProtocolNumber({ integer: true, minimum: 1 }),
  native: TriageScanContinuationV1Schema.optional(),
  evidence: TriageSourceScanEvidenceV1Schema.optional(),
}, { policy: 'closed' });

function withoutCount(evidence: TriageSourceScanEvidenceV1): TriageSourceScanEvidenceV1 {
  if (evidence.kind !== 'partial') return evidence;
  const { omittedItemCount: _count, ...retained } = evidence;
  return retained;
}

function combineEvidence(previous: TriageSourceScanEvidenceV1 | undefined, current: TriageSourceScanEvidenceV1): TriageSourceScanEvidenceV1 {
  if (previous === undefined || previous.kind === 'walkFinished') return current;
  if (current.kind === 'walkFinished') return previous;
  if (previous.kind === 'partial') return { ...current, kind: 'partial', reason: previous.reason,
    ...(previous.failure === undefined ? {} : { failure: previous.failure }) };
  return current;
}

/**
 * Traverse selected units through the source's existing native scan, one native
 * page per call. Keeping only the current unit's frontier avoids multiplying
 * provider query limits or continuation size by the selection count. Provider
 * lanes, authorization, mapping and native continuation validation stay native.
 */
export async function scanTriageSelectedScopeUnitsV1(input: Readonly<{
  instance: TriageConfiguredSourceInstanceV1;
  selection: TriageSourceScopeSelectionV1;
  page: TriageScanInputV1['page'];
  scan: (unitId: string | null, page: TriageScanInputV1['page']) => Promise<TriageScanResultV1>;
}>): Promise<TriageScanResultV1> {
  if (input.selection.kind === 'all') return await input.scan(null, input.page);
  const instanceDigest = deriveTriageConfiguredSourceInstanceDigestV1(input.instance);
  let index = 0;
  let limit: number;
  let page: TriageScanInputV1['page'];
  let previous: TriageSourceScanEvidenceV1 | undefined;
  if (input.page.kind === 'initial') {
    limit = input.page.limit;
    page = input.page;
  } else {
    const parsed = frontierSchema.safeParse(decodeTriagePagingTokenV1(input.page.continuation.token));
    if (!parsed.success || parsed.data.instanceDigest !== instanceDigest
      || input.selection.unitIds[parsed.data.index] !== parsed.data.unitId) {
      return { kind: 'failed', failure: { class: 'unsupportedContract', code: 'triage_scope_continuation_invalid' } };
    }
    index = parsed.data.index;
    limit = parsed.data.limit;
    previous = parsed.data.evidence === undefined ? undefined : withoutCount(parsed.data.evidence);
    page = parsed.data.native === undefined ? { kind: 'initial', limit }
      : { kind: 'continuation', continuation: parsed.data.native };
  }
  const unitId = input.selection.unitIds[index];
  if (unitId === undefined) return { kind: 'failed', failure: { class: 'unsupportedContract', code: 'triage_scope_selection_invalid' } };
  const result = await input.scan(unitId, page);
  if (result.kind === 'failed') return result;
  const evidence = combineEvidence(previous, result.evidence);
  const nextIndex = result.kind === 'page' ? index : index + 1;
  const nextId = input.selection.unitIds[nextIndex];
  if (nextId === undefined) return { kind: 'complete', observations: result.observations, evidence };
  const retainedEvidence = result.kind === 'page' ? previous : withoutCount(evidence);
  const token = encodeTriagePagingTokenV1({
    v: 1, kind: 'selected-scopes', instanceDigest, index: nextIndex, unitId: nextId, limit,
    ...(result.kind === 'page' ? { native: result.continuation } : {}),
    ...(retainedEvidence === undefined ? {} : { evidence: retainedEvidence }),
  });
  if (token === null) return { kind: 'complete', observations: result.observations,
    evidence: { kind: 'partial', reason: 'continuation-unavailable',
      ...(evidence.kind === 'partial' && evidence.failure !== undefined ? { failure: evidence.failure } : {}),
      ...(evidence.kind === 'partial' && evidence.omittedItemCount !== undefined ? { omittedItemCount: evidence.omittedItemCount } : {}),
    } };
  return { kind: 'page', observations: result.observations,
    evidence: evidence.kind === 'walkFinished' ? { kind: 'partial', reason: 'scope-selection' } : evidence,
    continuation: { v: 1, token },
  };
}
