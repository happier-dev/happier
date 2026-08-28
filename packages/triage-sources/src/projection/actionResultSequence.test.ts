import {
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  isExternalActionResultWithinResponseEnvelopeLimitV1,
} from '@happier-dev/plugin-sdk/actions';
import { describe, expect, it, vi } from 'vitest';
import {
  fitActionResultPageV1,
  fitActionResultSequenceV1,
} from './actionResultSequence.js';

vi.mock('@happier-dev/plugin-sdk/actions', async () => (
  import('../../../protocol/src/actions/externalActionApi.js')
));

describe('fitActionResultSequenceV1', () => {
  const project = (rows: readonly string[], omittedCount: number) => ({ rows, omittedCount });
  it('keeps an already fitting sequence without inventing a count ceiling', () => {
    const rows = Array.from({ length: 1_001 }, (_, index) => `row-${index}`);
    expect(fitActionResultSequenceV1(rows, project)).toEqual({ result: project(rows, 0), includedCount: rows.length });
  });
  it('fits the largest prefix against the serialized envelope including JSON escapes', () => {
    const rows = Array.from({ length: 16 }, () => '"\\\n'.repeat(400_000));
    const fitted = fitActionResultSequenceV1(rows, project);
    expect(fitted.includedCount).toBeLessThan(rows.length);
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(fitted.result)).toBe(true);
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(
      project(rows.slice(0, fitted.includedCount + 1), rows.length - fitted.includedCount - 1),
    )).toBe(false);
  }, 30_000);
});

describe('fitActionResultPageV1', () => {
  const project = (
    rows: readonly string[],
    omittedCount: number,
    continuation: string | undefined,
    continuationOmitted: boolean,
  ) => ({
    rows,
    omittedCount,
    ...(continuation === undefined ? {} : { continuation }),
    ...(continuationOmitted ? { incomplete: 'continuationUnavailable' as const } : {}),
  });

  it('preserves an ordinary provider continuation while fitting rows', () => {
    const rows = ['row-1', 'row-2'];
    const continuation = 'provider-page-2';
    expect(fitActionResultPageV1(rows, continuation, project)).toEqual({
      result: project(rows, 0, continuation, false),
      includedCount: rows.length,
      continuationIncluded: true,
    });
  });

  it('retains fitting rows and reports an Action-envelope-sized continuation as unavailable', () => {
    const rows = ['row-1'];
    const continuation = 'c'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    const fitted = fitActionResultPageV1(rows, continuation, project);
    expect(fitted).toEqual({
      result: project(rows, 0, undefined, true),
      includedCount: rows.length,
      continuationIncluded: false,
    });
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(fitted.result)).toBe(true);
  });

  it('does not hide a non-continuation base-shape overflow', () => {
    const oversizedBase = 'b'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    expect(() => fitActionResultPageV1([], undefined, (rows, omittedCount) => ({
      rows,
      omittedCount,
      oversizedBase,
    }))).toThrowError('action_result_base_exceeds_serialized_boundary');
  });
});
