import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/providerSpecs';

describe('providers: scenario capability gating', () => {
  it('does not require ACP model probe for kilo', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const kilo = providers.find((provider) => provider.id === 'kilo');
    expect(kilo).toBeTruthy();
    expect(kilo!.scenarioRegistry.tiers.extended).not.toContain('acp_probe_models');
  });

  it('does not require ACP resume-load scenarios for qwen', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const qwen = providers.find((provider) => provider.id === 'qwen');
    expect(qwen).toBeTruthy();
    expect(qwen!.scenarioRegistry.tiers.extended).not.toContain('acp_resume_load_session');
    expect(qwen!.scenarioRegistry.tiers.extended).not.toContain('acp_resume_fresh_session_imports_history');
    expect(qwen!.scenarioRegistry.tiers.extended).not.toContain('read_known_file');
    expect(qwen!.scenarioRegistry.tiers.extended).not.toContain('read_missing_file_in_workspace');
    expect(qwen!.scenarioRegistry.tiers.extended).not.toContain('search_known_token');
    expect(qwen!.scenarioRegistry.tiers.extended).not.toContain('search_ls_equivalence');
    expect(qwen!.scenarioRegistry.tiers.extended).not.toContain('glob_list_files');
    expect(qwen!.scenarioRegistry.tiers.extended).not.toContain('edit_result_includes_diff');
    expect(qwen!.scenarioRegistry.tiers.extended).not.toContain('multi_file_edit_in_workspace');
    expect(qwen!.scenarioRegistry.tiers.extended).not.toContain('multi_file_edit_in_workspace_includes_diff');
    expect(qwen!.scenarioRegistry.tiers.extended).not.toContain('permission_mode_default_outside_workspace');
    expect(qwen!.scenarioRegistry.tiers.extended).not.toContain('permission_mode_safe_yolo_outside_workspace');
    expect(qwen!.scenarioRegistry.tiers.extended).not.toContain('permission_mode_read_only_outside_workspace');
    expect(qwen!.scenarioRegistry.tiers.extended).not.toContain('permission_mode_yolo_outside_workspace');
  });

  it('does not require ACP resume-load scenarios for kimi', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const kimi = providers.find((p) => p.id === 'kimi');
    expect(kimi).toBeTruthy();
    expect(kimi!.scenarioRegistry.tiers.extended).not.toContain('acp_resume_load_session');
    expect(kimi!.scenarioRegistry.tiers.extended).not.toContain('acp_resume_fresh_session_imports_history');
  });

  it('does not require ACP resume-load scenarios for auggie', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const auggie = providers.find((provider) => provider.id === 'auggie');
    expect(auggie).toBeTruthy();
    expect(auggie!.scenarioRegistry.tiers.extended).not.toContain('acp_resume_load_session');
    expect(auggie!.scenarioRegistry.tiers.extended).not.toContain('acp_resume_fresh_session_imports_history');
  });

  it('allows kimi host-auth fallback by default', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const kimi = providers.find((provider) => provider.id === 'kimi');
    expect(kimi).toBeTruthy();
    expect(kimi!.auth?.mode).toBe('auto');
  });
});
