import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readBundledPluginPackageNames } from './bundledPluginMembership';
import { loadProvidersFromCliSpecs } from '../../../../packages/tests/src/testkit/providers/specs/providerSpecs';
import { scenarioCatalog } from '../../../../packages/tests/src/testkit/providers/scenarios/scenarioCatalog';

describe('CodeBuddy bundled Agent', () => {
  it('is available through the canonical bundled plugin membership owner', () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    expect(readBundledPluginPackageNames(root)).toContain('@happier-dev/plugins-codebuddy');
  });
  it('discovers CodeBuddy and composes its declared provider scenarios through the generic owners', async () => {
    const provider = (await loadProvidersFromCliSpecs()).find((entry) => entry.id === 'codebuddy');
    expect(provider).toMatchObject({
      protocol: 'acp',
      enableEnvVar: 'HAPPIER_E2E_PROVIDER_CODEBUDDY',
      cli: { subcommand: 'codebuddy' },
      auth: { mode: 'auto', env: { requiredAnyOf: [['CODEBUDDY_API_KEY']] } },
    });
    if (!provider) throw new Error('CodeBuddy provider was not discovered');
    const scenarioIds = [...provider.scenarioRegistry.tiers.smoke, ...provider.scenarioRegistry.tiers.extended];
    expect(scenarioIds).toContain('acp_set_model_dynamic');
    for (const id of scenarioIds) {
      expect(scenarioCatalog[id](provider).id).toBe(id);
    }
  });
});
