import {
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  isExternalActionResultWithinResponseEnvelopeLimitV1,
  measureExternalActionResultResponseEnvelopeUtf8BytesV1,
} from '@happier-dev/plugin-sdk/actions';
import { fitActionResultSequenceV1 } from '@happier-dev/triage-sources/projection/actionResultSequence';

import type { GithubChangedFilesResultV1 } from './contracts.js';
import { decodeGithubDetailContinuation, encodeGithubDetailContinuation } from './continuation.js';

/** Preserve inventory when exact text cannot cross the existing Action envelope. */
export function fitGithubChangedFilesPage(
  result: Extract<GithubChangedFilesResultV1, { kind: 'changedFiles' }>,
  perPage: number,
): GithubChangedFilesResultV1 {
  const resultBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1(result);
  if (resultBytes <= EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) return result;
  const comparison = result.comparison;
  const rows = [...result.rows];
  const order = rows.flatMap((row, index) => row.evidence !== undefined && 'patch' in row.evidence && row.evidence.patch.length > 0
    ? [{ index, evidence: row.evidence }] : [])
    .sort((a, b) => b.evidence.patch.length - a.evidence.patch.length);
  const frontier = result.continuation === undefined ? null : decodeGithubDetailContinuation(result.continuation);
  const continuation = frontier?.comparison === undefined ? null : encodeGithubDetailContinuation({ ...frontier,
    comparison: { ...frontier.comparison, contentIncomplete: true },
  });
  const incompleteComparison = comparison === undefined ? undefined : Object.freeze({ ...comparison,
    content: 'incomplete' as const, reasons: Object.freeze([...comparison.reasons, 'transport_limit']),
  });
  const shape = () => Object.freeze({ ...result, rows: Object.freeze([...rows]),
    ...(incompleteComparison === undefined ? {} : { comparison: incompleteComparison }),
    ...(continuation === null ? {} : { continuation }),
  });
  // These projected plain JSON objects have the same encoding as the canonical
  // token measurer. Only these fields and each replaced evidence value change;
  // the enclosing keys, separators, rows and transport framing stay identical.
  const encoder = new TextEncoder();
  const encodedBytes = (value: object) => encoder.encode(JSON.stringify(value)).byteLength;
  let remainingBytes = resultBytes
    + encodedBytes({ comparison: incompleteComparison, continuation: continuation ?? result.continuation })
    - encodedBytes({ comparison, continuation: result.continuation });
  const unavailableEvidence = Object.freeze({ state: 'unavailable' as const, reason: 'transport_limit' as const });
  const unavailableEvidenceBytes = encodedBytes(unavailableEvidence);
  for (const item of order) {
    if (remainingBytes <= EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) break;
    remainingBytes -= encodedBytes(item.evidence) - unavailableEvidenceBytes;
    rows[item.index] = { ...rows[item.index]!, evidence: unavailableEvidence };
  }
  const fitted = shape();
  if (isExternalActionResultWithinResponseEnvelopeLimitV1(fitted)) return fitted;
  // Path/inventory bytes themselves can exceed the same transport contract. The
  // existing sequence fitter keeps a usable prefix and states omitted evidence.
  return fitActionResultSequenceV1(rows, (included, omitted) => ({ ...shape(), rows: included,
    omittedRowCount: result.omittedRowCount + omitted, projectionTruncated: true,
    ...(comparison === undefined ? {} : { comparison: { ...comparison, content: 'incomplete' as const,
      reasons: [...comparison.reasons, 'transport_limit'], inventory: 'incomplete' as const } }),
    ...(frontier?.comparison === undefined ? {} : { continuation: encodeGithubDetailContinuation({ ...frontier, perPage,
      comparison: { ...frontier.comparison, contentIncomplete: true, inventoryIncomplete: true },
    }) ?? undefined }),
  })).result;
}
