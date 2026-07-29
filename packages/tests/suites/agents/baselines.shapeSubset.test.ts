import { describe, expect, it } from 'vitest';

import { diffProviderBaseline, type ProviderBaselineV1 } from '../../src/testkit/providers/baselines';
import { normalizeShapeForBaseline, shapeOf, stableStringifyShape } from '../../src/testkit/providers/shape';

describe('providers: baseline diff (shape subset)', () => {
  it('does not fail when an observed payload adds extra object keys beyond the baseline shape', () => {
    const baselineKey = 'acp/opencode/tool-call/Edit';

    const baselinePayload = {
      type: 'tool-call',
      callId: 'call_1',
      name: 'Edit',
      input: {
        filepath: '/tmp/file.txt',
        parentDir: '/tmp',
        locations: [],
        _acp: { kind: 'edit', rawInput: {}, title: 'edit' },
        _happier: { v: 2, protocol: 'acp', provider: 'opencode', rawToolName: 'edit', canonicalToolName: 'Edit' },
        _raw: { anything: true },
        description: 'edit',
      },
      id: 'tool_1',
    };

    const observedPayload = {
      ...baselinePayload,
      input: {
        ...baselinePayload.input,
        filePath: '/tmp/file.txt',
        oldString: '',
        newString: 'HELLO',
      },
    };

    const baseline: ProviderBaselineV1 = {
      v: 1,
      providerId: 'opencode',
      scenarioId: 'permission_deny_outside_workspace',
      createdAt: '2026-02-04T00:00:00.000Z',
      fixtureKeys: [baselineKey],
      shapesByKey: {
        [baselineKey]: stableStringifyShape(normalizeShapeForBaseline(shapeOf(baselinePayload))),
      },
    };

    const res = diffProviderBaseline({
      baseline,
      observedFixtureKeys: [baselineKey],
      observedExamples: { [baselineKey]: [{ payload: observedPayload }] },
      allowExtraKeys: true,
    });

    expect(res.ok).toBe(true);
  });

  it('fails when an existing field changes type even if extra keys are present', () => {
    const baselineKey = 'acp/opencode/tool-call/Edit';

    const baselinePayload = {
      type: 'tool-call',
      callId: 'call_1',
      name: 'Edit',
      input: {
        filepath: '/tmp/file.txt',
        parentDir: '/tmp',
        locations: [],
        _acp: { kind: 'edit', rawInput: {}, title: 'edit' },
        _happier: { v: 2, protocol: 'acp', provider: 'opencode', rawToolName: 'edit', canonicalToolName: 'Edit' },
        _raw: { anything: true },
      },
      id: 'tool_1',
    };

    const observedPayload = {
      ...baselinePayload,
      input: {
        ...baselinePayload.input,
        filepath: 123,
        oldString: '',
        newString: 'HELLO',
      },
    };

    const baseline: ProviderBaselineV1 = {
      v: 1,
      providerId: 'opencode',
      scenarioId: 'permission_deny_outside_workspace',
      createdAt: '2026-02-04T00:00:00.000Z',
      fixtureKeys: [baselineKey],
      shapesByKey: {
        [baselineKey]: stableStringifyShape(normalizeShapeForBaseline(shapeOf(baselinePayload))),
      },
    };

    const res = diffProviderBaseline({
      baseline,
      observedFixtureKeys: [baselineKey],
      observedExamples: { [baselineKey]: [{ payload: observedPayload }] },
      allowExtraKeys: true,
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.reason).toContain('Payload shape drifted');
  });
});
