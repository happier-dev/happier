import { isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/plugin-sdk/actions';
import { describe, expect, it, vi } from 'vitest';
import { fitActionResultTextV1 } from './actionResultText.js';

vi.mock('@happier-dev/plugin-sdk/actions', async () => (
  import('../../../protocol/src/actions/externalActionApi.js')
));

describe('fitActionResultTextV1', () => {
  const project = (text: string, truncated: boolean) => ({ kind: 'evidence' as const, text, truncated });

  it('keeps a result that already fits the canonical Action boundary', () => {
    expect(fitActionResultTextV1('small diff', project)).toEqual(project('small diff', false));
  });

  it('fits escaped and multi-byte text in a bounded number of projections', () => {
    const text = `${'"\\\n'.repeat(4_000_000)}🚀`;
    let projectionCount = 0;
    const result = fitActionResultTextV1(text, (value, truncated) => {
      projectionCount += 1;
      return project(value, truncated);
    });
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith('\ud83d')).toBe(false);
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
    const nextCodePoint = Array.from(text.slice(result.text.length))[0];
    expect(nextCodePoint).toBeDefined();
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(project(`${result.text}${nextCodePoint}`, true))).toBe(false);
    expect(projectionCount).toBeLessThanOrEqual(4);
  });
});
