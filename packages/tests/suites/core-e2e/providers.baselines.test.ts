import { describe, expect, it } from 'vitest';

import { stableStringifyShape, shapeOf } from '../../src/testkit/providers/shape';
import {
  computeProviderBaselineV1,
  diffProviderBaseline,
  type ProviderBaselineV1,
} from '../../src/testkit/providers/baselines';

function makeBaseline(params: {
  providerId: string;
  scenarioId: string;
  fixtureKeys: string[];
  fixturesExamples: Record<string, unknown>;
  existing?: ProviderBaselineV1 | null;
}): ProviderBaselineV1 {
  return computeProviderBaselineV1({
    providerId: params.providerId,
    scenarioId: params.scenarioId,
    fixtureKeys: params.fixtureKeys,
    fixturesExamples: params.fixturesExamples,
    existing: params.existing ?? null,
    nowIso: '2026-02-03T00:00:00.000Z',
  });
}

describe('providers: baselines', () => {
  it('shrinks baseline keyset when updating (no sticky union merge)', () => {
    const fixturesExamples: Record<string, unknown> = {
      a: [{ payload: { a: 1 } }],
      b: [{ payload: { b: 2 } }],
    };

    const existing = makeBaseline({
      providerId: 'p',
      scenarioId: 's',
      fixtureKeys: ['a', 'b'],
      fixturesExamples,
    });

    const updated = makeBaseline({
      providerId: 'p',
      scenarioId: 's',
      fixtureKeys: ['a'],
      fixturesExamples,
      existing,
    });

    expect(updated.fixtureKeys).toEqual(['a']);
    expect(Object.keys(updated.shapesByKey)).toEqual(['a']);
  });

  it('fails when observed fixtures are missing baseline keys', () => {
    const fixturesExamples: Record<string, unknown> = {
      a: [{ payload: { a: 1 } }],
      b: [{ payload: { b: 2 } }],
    };

    const baseline = makeBaseline({
      providerId: 'p',
      scenarioId: 's',
      fixtureKeys: ['a', 'b'],
      fixturesExamples,
    });

    const diff = diffProviderBaseline({
      baseline,
      observedFixtureKeys: ['a'],
      observedExamples: fixturesExamples,
      allowExtraKeys: true,
    });
    expect(diff.ok).toBe(false);
    if (diff.ok) throw new Error('expected failure');
    expect(diff.reason).toContain('missing keys');
    expect(diff.reason).toContain('b');
  });

  it('allows extra observed keys by default (non-strict)', () => {
    const fixturesExamples: Record<string, unknown> = {
      a: [{ payload: { a: 1 } }],
      extra: [{ payload: { x: 1 } }],
    };

    const baseline = makeBaseline({
      providerId: 'p',
      scenarioId: 's',
      fixtureKeys: ['a'],
      fixturesExamples,
    });

    const diff = diffProviderBaseline({
      baseline,
      observedFixtureKeys: ['a', 'extra'],
      observedExamples: fixturesExamples,
      allowExtraKeys: true,
    });
    expect(diff.ok).toBe(true);
  });

  it('fails on extra observed keys in strict mode', () => {
    const fixturesExamples: Record<string, unknown> = {
      a: [{ payload: { a: 1 } }],
      extra: [{ payload: { x: 1 } }],
    };

    const baseline = makeBaseline({
      providerId: 'p',
      scenarioId: 's',
      fixtureKeys: ['a'],
      fixturesExamples,
    });

    const diff = diffProviderBaseline({
      baseline,
      observedFixtureKeys: ['a', 'extra'],
      observedExamples: fixturesExamples,
      allowExtraKeys: false,
    });
    expect(diff.ok).toBe(false);
    if (diff.ok) throw new Error('expected failure');
    expect(diff.reason).toContain('unexpected keys');
    expect(diff.reason).toContain('extra');
  });

  it('fails when a baselined payload shape drifts', () => {
    const fixturesExamples: Record<string, unknown> = {
      a: [{ payload: { a: 1 } }],
    };

    const baseline = makeBaseline({
      providerId: 'p',
      scenarioId: 's',
      fixtureKeys: ['a'],
      fixturesExamples,
    });

    // Mutate observed payload shape to differ.
    const observedExamples: Record<string, unknown> = {
      a: [{ payload: { a: 1, extra: true } }],
    };

    const diff = diffProviderBaseline({
      baseline,
      observedFixtureKeys: ['a'],
      observedExamples,
      allowExtraKeys: true,
    });
    expect(diff.ok).toBe(false);
    if (diff.ok) throw new Error('expected failure');
    expect(diff.reason).toContain('Payload shape drifted');

    // Sanity: expected shape string differs.
    const expected = baseline.shapesByKey['a'];
    const observed = stableStringifyShape(shapeOf((observedExamples.a as any[])[0].payload));
    expect(observed).not.toBe(expected);
  });
});

