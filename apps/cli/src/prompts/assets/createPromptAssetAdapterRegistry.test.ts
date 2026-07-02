import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createPromptAssetAdapterRegistry } from './createPromptAssetAdapterRegistry';

describe('createPromptAssetAdapterRegistry', () => {
  it('uses generated plugin-owned prompt asset descriptors', () => {
    const registry = createPromptAssetAdapterRegistry();
    const copilotDescriptor = registry.get('copilot.skill')?.descriptor;
    const geminiDescriptor = registry.get('gemini.skill')?.descriptor;

    expect(copilotDescriptor).toMatchObject({
      id: 'copilot.skill',
      providerId: 'copilot',
      libraryKind: 'bundle',
      formatId: 'skill_md_v1',
    });
    expect(geminiDescriptor).toMatchObject({
      id: 'gemini.skill',
      providerId: 'gemini',
      libraryKind: 'bundle',
      formatId: 'skill_md_v1',
    });

    const source = readFileSync(new URL('./createPromptAssetAdapterRegistry.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/\.\/generated\/pluginDescriptors/);
    expect(source).not.toMatch(/@happier-dev\/plugins-claude\/agent['"]/);
    expect(source).not.toMatch(/@happier-dev\/plugins-copilot['"]/);
    expect(source).not.toMatch(/@\/backends\/copilot\/promptAssets/);
    expect(source).not.toMatch(/@\/backends\/gemini\/promptAssets/);
  });
});
