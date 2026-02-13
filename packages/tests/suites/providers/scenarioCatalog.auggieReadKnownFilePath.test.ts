import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/specs/providerSpecs';
import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';

describe('scenarioCatalog: auggie read_known_file path mode', () => {
  it('uses an absolute path for auggie read_known_file prompts', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const auggie = providers.find((provider) => provider.id === 'auggie');
    expect(auggie).toBeTruthy();
    if (!auggie) throw new Error('Missing provider spec for auggie');

    const scenario = scenarioCatalog.read_known_file(auggie);
    const workspaceDir = '/tmp/happier-auggie-read-known-file';
    const prompt = scenario.prompt?.({ workspaceDir });
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain(join(workspaceDir, 'e2e-read.txt'));

    const anyFixtureKeys = (scenario.requiredAnyFixtureKeys ?? []).flat();
    expect(anyFixtureKeys.some((key) => key.includes('/tool-call/Bash'))).toBe(true);
  });

  it('uses absolute paths for auggie edit diff prompts', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const auggie = providers.find((provider) => provider.id === 'auggie');
    expect(auggie).toBeTruthy();
    if (!auggie) throw new Error('Missing provider spec for auggie');

    const scenario = scenarioCatalog.edit_result_includes_diff(auggie);
    const workspaceDir = '/tmp/happier-auggie-edit-known-file';
    const prompt = scenario.prompt?.({ workspaceDir });
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain(join(workspaceDir, 'e2e-edit-diff.txt'));
  });

  it('uses absolute paths for auggie multi-file edit diff step prompts', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const auggie = providers.find((provider) => provider.id === 'auggie');
    expect(auggie).toBeTruthy();
    if (!auggie) throw new Error('Missing provider spec for auggie');

    const scenario = scenarioCatalog.multi_file_edit_in_workspace_includes_diff(auggie);
    const workspaceDir = '/tmp/happier-auggie-edit-multi-file';
    const stepPrompt = scenario.steps?.[0]?.prompt?.({ workspaceDir });
    expect(typeof stepPrompt).toBe('string');
    expect(stepPrompt).toContain(join(workspaceDir, 'e2e-multi-diff-a.txt'));
  });
});
