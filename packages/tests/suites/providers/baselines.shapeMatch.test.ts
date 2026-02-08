import { describe, expect, it } from 'vitest';

import { diffProviderBaseline, type ProviderBaselineV1 } from '../../src/testkit/providers/baselines';
import { normalizeShapeForBaseline, shapeOf, stableStringifyShape } from '../../src/testkit/providers/shape';

describe('providers: baseline diff (shape matching)', () => {
  it('accepts any observed fixture example that matches the baselined payload shape', () => {
    const baselineKey = 'acp/opencode/tool-call/Bash';

    const minimalPayload = {
      type: 'tool-call',
      callId: 'call_1',
      name: 'Bash',
      input: {
        description: 'bash',
        locations: [],
        _acp: { kind: 'execute', rawInput: {}, title: 'bash' },
        _happier: { v: 2, protocol: 'acp', provider: 'opencode', rawToolName: 'execute', canonicalToolName: 'Bash' },
        _raw: { anything: true },
      },
      id: 'tool_1',
    };

    const informativePayload = {
      ...minimalPayload,
      input: {
        ...minimalPayload.input,
        command: 'echo HELLO',
        _acp: { kind: 'unknown', rawInput: { command: 'echo HELLO' } },
      },
    };

    const expectedShape = stableStringifyShape(normalizeShapeForBaseline(shapeOf(minimalPayload)));

    const baseline: ProviderBaselineV1 = {
      v: 1,
      providerId: 'opencode',
      scenarioId: 'acp_resume_load_session',
      createdAt: '2026-02-04T00:00:00.000Z',
      fixtureKeys: [baselineKey],
      shapesByKey: { [baselineKey]: expectedShape },
    };

    const res = diffProviderBaseline({
      baseline,
      observedFixtureKeys: [baselineKey],
      observedExamples: {
        [baselineKey]: [
          { payload: informativePayload },
          { payload: minimalPayload },
        ],
      },
      allowExtraKeys: true,
    });

    expect(res.ok).toBe(true);
  });
});

