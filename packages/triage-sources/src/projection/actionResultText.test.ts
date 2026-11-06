import { isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/plugin-sdk/actions';
import { describe, expect, it } from 'vitest';
import { fitActionResultTextV1 } from './actionResultText.js';

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

  it('uses the actual caller budget and framing without splitting an oversized Unicode line', () => {
    const text = '😀"\\\n'.repeat(1000);
    const measureSerializedBytes = (result: ReturnType<typeof project>) => new TextEncoder().encode(JSON.stringify({ prompt: result })).length;
    const result = fitActionResultTextV1(text, project, { maxSerializedBytes: 151, measureSerializedBytes });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).not.toMatch(/[\ud800-\udbff]$/u);
    expect(measureSerializedBytes(result)).toBeLessThanOrEqual(151);
    const next = Array.from(text.slice(result.text.length))[0]!;
    expect(measureSerializedBytes(project(result.text + next, true))).toBeGreaterThan(151);
    expect(() => fitActionResultTextV1(text, project, { maxSerializedBytes: 1, measureSerializedBytes })).toThrow('action_result_base_exceeds_serialized_boundary');
  });
});
