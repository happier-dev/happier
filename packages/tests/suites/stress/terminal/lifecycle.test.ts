import { describe, expect, it } from 'vitest';

import {
  TERMINAL_FOUNDATION_LIFECYCLE_SCENARIO_IDS,
  assertTerminalValidationMatrixCovers,
  listTerminalFoundationLifecycleScenarios,
} from '../../../src/testkit/terminal/matrix';

describe('stress: terminal foundation lifecycle validation matrix', () => {
  it('keeps the TERM-7a lifecycle matrix complete and explicit', () => {
    const scenarios = listTerminalFoundationLifecycleScenarios();

    expect(scenarios).toHaveLength(TERMINAL_FOUNDATION_LIFECYCLE_SCENARIO_IDS.length);
    expect(() => assertTerminalValidationMatrixCovers(
      scenarios.map((scenario) => scenario.id),
    )).not.toThrow();
    expect(scenarios.every((scenario) => scenario.requiredEvidence.length > 0)).toBe(true);
  });
});
