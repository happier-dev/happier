import { describe, expect, it } from 'vitest';

import { createPromptProviderCatalog } from './promptProviderCatalog';
import { createPromptRegistryCatalog } from './promptRegistryCatalog';

describe('prompt catalog contracts', () => {
  it('creates empty prompt provider and registry catalogs without scanning runtime sources', () => {
    expect(createPromptProviderCatalog().entries).toEqual([]);
    expect(createPromptRegistryCatalog().entries).toEqual([]);
  });

  it('preserves explicit prompt provider and registry entries as catalog data', () => {
    expect(createPromptProviderCatalog([
      {
        id: 'prompt-provider-1',
        pluginId: 'plugin.prompts',
        adapterExportName: 'registerPromptProvider',
      },
    ]).entries).toEqual([
      {
        id: 'prompt-provider-1',
        pluginId: 'plugin.prompts',
        adapterExportName: 'registerPromptProvider',
      },
    ]);
    expect(createPromptRegistryCatalog([
      {
        id: 'prompt-registry-1',
        pluginId: 'plugin.prompts',
        adapterExportName: 'registerPromptRegistry',
      },
    ]).entries).toEqual([
      {
        id: 'prompt-registry-1',
        pluginId: 'plugin.prompts',
        adapterExportName: 'registerPromptRegistry',
      },
    ]);
  });
});
