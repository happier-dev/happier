import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/specs/providerSpecs';

describe('providers: pi spec wiring', () => {
  it('loads pi provider spec with smoke and extended scenario tiers', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const pi = providers.find((provider) => provider.id === 'pi');

    expect(pi).toBeTruthy();
    expect(pi?.protocol).toBe('acp');
    expect(pi?.cli.subcommand).toBe('pi');
    expect(pi?.traceProvider).toBe('pi');

    expect(pi?.scenarioRegistry.tiers.smoke).toContain('pi_read_known_file_smoke');
    expect(pi?.scenarioRegistry.tiers.extended).toContain('acp_probe_models');
    expect(pi?.scenarioRegistry.tiers.extended).not.toContain('edit_result_includes_diff');
    expect(pi?.scenarioRegistry.tiers.extended).not.toContain('multi_file_edit_in_workspace_includes_diff');
  });
});
