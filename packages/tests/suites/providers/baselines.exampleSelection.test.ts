import { describe, expect, it } from 'vitest';

import { computeProviderBaselineV1, stableStringifyBaselineShapeEntry } from '../../src/testkit/providers/baselines';

describe('providers: baseline shape sampling', () => {
  it('prefers the most informative fixture example when computing baseline shapes', () => {
    const fixturesExamples: Record<string, unknown> = {
      'acp/opencode/tool-call/Edit': [
        {
          payload: {
            type: 'tool-call',
            callId: 'c1',
            id: 'm1',
            name: 'Edit',
            input: { _happier: { v: 2, protocol: 'acp', provider: 'opencode', rawToolName: 'edit', canonicalToolName: 'Edit' } },
          },
        },
        {
          payload: {
            type: 'tool-call',
            callId: 'c1',
            id: 'm1',
            name: 'Edit',
            input: {
              filepath: '/tmp/x.txt',
              parentDir: '/tmp',
              _happier: { v: 2, protocol: 'acp', provider: 'opencode', rawToolName: 'edit', canonicalToolName: 'Edit' },
            },
          },
        },
      ],
    };

    const baseline = computeProviderBaselineV1({
      providerId: 'opencode',
      scenarioId: 'sample',
      fixtureKeys: ['acp/opencode/tool-call/Edit'],
      fixturesExamples,
      nowIso: '2026-02-04T00:00:00.000Z',
    });

    const shape = stableStringifyBaselineShapeEntry(baseline.shapesByKey['acp/opencode/tool-call/Edit']) ?? '';
    expect(shape).toContain('\"filepath\"');
  });

  it('uses stable first-observed selection when example informativeness score ties', () => {
    const fixturesExamples: Record<string, unknown> = {
      'acp/opencode/tool-call/Edit': [
        {
          payload: {
            type: 'tool-call',
            callId: 'c1',
            id: 'm1',
            name: 'Edit',
            input: {
              alpha: { x: 1 },
              _happier: { v: 2, protocol: 'acp', provider: 'opencode', rawToolName: 'edit', canonicalToolName: 'Edit' },
            },
          },
        },
        {
          payload: {
            type: 'tool-call',
            callId: 'c1',
            id: 'm1',
            name: 'Edit',
            input: {
              beta: { y: 2 },
              _happier: { v: 2, protocol: 'acp', provider: 'opencode', rawToolName: 'edit', canonicalToolName: 'Edit' },
            },
          },
        },
      ],
    };

    const baseline = computeProviderBaselineV1({
      providerId: 'opencode',
      scenarioId: 'sample',
      fixtureKeys: ['acp/opencode/tool-call/Edit'],
      fixturesExamples,
      nowIso: '2026-02-04T00:00:00.000Z',
    });

    const shape = stableStringifyBaselineShapeEntry(baseline.shapesByKey['acp/opencode/tool-call/Edit']) ?? '';
    expect(shape).toContain('\"alpha\"');
    expect(shape).not.toContain('\"beta\"');
  });

  it('preserves existing createdAt when recomputing baseline without explicit timestamp override', () => {
    const fixturesExamples: Record<string, unknown> = {
      'acp/opencode/tool-call/Edit': [
        {
          payload: {
            type: 'tool-call',
            callId: 'c1',
            id: 'm1',
            name: 'Edit',
            input: {
              alpha: { x: 1 },
              _happier: { v: 2, protocol: 'acp', provider: 'opencode', rawToolName: 'edit', canonicalToolName: 'Edit' },
            },
          },
        },
      ],
    };

    const baseline = computeProviderBaselineV1({
      providerId: 'opencode',
      scenarioId: 'sample',
      fixtureKeys: ['acp/opencode/tool-call/Edit'],
      fixturesExamples,
      existing: {
        v: 1,
        providerId: 'opencode',
        scenarioId: 'sample',
        createdAt: '2026-01-01T00:00:00.000Z',
        fixtureKeys: ['acp/opencode/tool-call/Edit'],
        shapesByKey: {},
      },
    });

    expect(baseline.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('stores computed baseline shapes as structured objects for diff-friendly review', () => {
    const fixturesExamples: Record<string, unknown> = {
      'acp/opencode/tool-call/Edit': [
        {
          payload: {
            type: 'tool-call',
            callId: 'c1',
            id: 'm1',
            name: 'Edit',
            input: {
              filepath: '/tmp/x.txt',
              _happier: { v: 2, protocol: 'acp', provider: 'opencode', rawToolName: 'edit', canonicalToolName: 'Edit' },
            },
          },
        },
      ],
    };

    const baseline = computeProviderBaselineV1({
      providerId: 'opencode',
      scenarioId: 'sample',
      fixtureKeys: ['acp/opencode/tool-call/Edit'],
      fixturesExamples,
      nowIso: '2026-02-04T00:00:00.000Z',
    });

    const shape = baseline.shapesByKey['acp/opencode/tool-call/Edit'];
    expect(shape && typeof shape === 'object').toBe(true);
    expect(shape && typeof shape === 'object' && 't' in shape ? shape.t : null).toBe('object');
  });
});
