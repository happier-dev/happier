import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';

describe('providers: auggie resume scenario policy', () => {
  const provider = {
    id: 'auggie',
    protocol: 'acp',
  } as any;

  it('relaxes fixture/trace strictness for auggie resume-load scenario', () => {
    const scenario = scenarioCatalog.acp_resume_load_session(provider);
    expect(scenario.requiredAnyFixtureKeys).toBeUndefined();
    expect(scenario.requiredTraceSubstrings).toBeUndefined();
    expect(scenario.assertPendingDrain).toBe(false);
  });

  it('relaxes fixture/trace strictness for auggie resume-fresh scenario', () => {
    const scenario = scenarioCatalog.acp_resume_fresh_session_imports_history(provider);
    expect(scenario.requiredAnyFixtureKeys).toBeUndefined();
    expect(scenario.requiredTraceSubstrings).toBeUndefined();
    expect(scenario.assertPendingDrain).toBe(false);
  });
});
