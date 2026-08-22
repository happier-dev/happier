import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createPromptAssetAdapterRegistry } from './createPromptAssetAdapterRegistry';

const externalAdapter = Object.freeze({
  descriptor: {
    id: 'acme.skill',
    providerId: 'acme',
    title: 'Acme skills',
    description: 'Acme SKILL.md bundles.',
    libraryKind: 'bundle' as const,
    supportsScope: { user: true, project: true },
    supportsFiles: true,
    formatId: 'skill_md_v1',
    defaultRoots: [],
    capabilities: {},
  },
  async discover() { return []; },
  async read() { return { ok: false as const, errorCode: 'unsupported' as const, error: 'fixture' }; },
  async writeDoc() { return { ok: false as const, errorCode: 'unsupported' as const, error: 'fixture' }; },
  async writeBundle() { return { ok: false as const, errorCode: 'unsupported' as const, error: 'fixture' }; },
  async delete() { return { ok: false as const, errorCode: 'unsupported' as const, error: 'fixture' }; },
});

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

  it('reads current external adapters through the canonical registry view', () => {
    let registered = new Map([['acme.skill', externalAdapter] as const]);
    const registry = createPromptAssetAdapterRegistry({
      readRegisteredAdapters: () => registered,
    });

    expect(registry.get('acme.skill')).toBe(externalAdapter);
    expect([...registry.values()]).toContain(externalAdapter);

    registered = new Map();
    expect(registry.get('acme.skill')).toBeUndefined();
  });
});
