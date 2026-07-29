import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/specs/providerSpecs';
import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';

describe('scenarioCatalog: kimi permission mode outside workspace', () => {
  it('does not require permission-request/tool-call fixtures when Kimi mode denies outside writes', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const kimi = providers.find((provider) => provider.id === 'kimi');
    expect(kimi).toBeTruthy();
    if (!kimi) throw new Error('Missing provider spec for kimi');

    const scenario = scenarioCatalog.permission_mode_default_outside_workspace(kimi);
    expect(scenario.requiredFixtureKeys ?? []).toEqual([]);
    expect(scenario.requiredAnyFixtureKeys ?? []).toEqual([]);
    expect(scenario.requiredTraceSubstrings ?? []).toContain('task_complete');
  });
});
