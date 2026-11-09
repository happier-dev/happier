import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../manifest.js';

describe('OLLAMA_PROVIDER_CONTRIBUTION', () => {
  it('declares the verified no-auth local endpoints, catalog, and bounded discovery contract', () => {
    expect(PLUGIN_MANIFEST.contributes.providers[0]).toMatchObject({
      v: 1,
      id: 'ollama',
      kind: 'local',
      endpointTemplates: [
        { id: 'ollama-native', protocol: 'ollama-native' },
        { id: 'ollama-openai-chat', protocol: 'openai-chat' },
        { id: 'ollama-openai-responses', protocol: 'openai-responses' },
      ],
      catalog: {
        source: 'static+probe',
        staticModels: [{ id: 'qwen2.5-coder:1.5b-base', contextWindowTokens: 32768,
          inlineCompletion: { operationId: 'native-fim', tokenAccounting: 'utf8-bytes', promptOverheadTokens: 3 } },
          { contextWindowTokens: 8192,
            nextEdit: { operationId: 'next-edit', tokenAccounting: 'utf8-bytes', promptOverheadTokens: 0 } }],
        sourceRegistryVersion: 'ollama-tags/v1',
        probes: [{ endpointTemplateId: 'ollama-native', path: '/api/tags', parser: 'ollama-tags' }],
      },
      managedRuntime: {
        kind: 'managed',
        endpointTemplateIds: [
          'ollama-native',
          'ollama-openai-chat',
          'ollama-openai-responses',
        ],
      },
      discovery: {
        v: 1,
        listener: {
          executableBasenames: ['ollama', 'ollama.exe'],
          argvMatch: { mode: 'containsAll', tokens: ['serve'] },
          defaultPorts: [11434],
        },
        availabilityProbe: { endpointTemplateId: 'ollama-native', path: '/api/tags', parser: 'ollama-tags' },
        catalogFallback: {
          endpointTemplateId: 'ollama-native', lookupNames: ['ollama'], fixedArgs: ['list'],
          parser: 'ollama-list-table', endpointEnvName: 'OLLAMA_HOST',
        },
      },
    });
    expect(PLUGIN_MANIFEST.contributes.providers[0].discovery)
      .not.toHaveProperty('managedStart');
    expect(PLUGIN_MANIFEST.contributes.providers[0].inlineCompletion).toEqual([
      { id: 'native-fim', mode: 'native-fim', endpointTemplateId: 'ollama-native', path: '/api/generate', wireFormat: 'ollama-generate' },
      { id: 'next-edit', mode: 'next-edit-codec', codec: 'rewrite-window-v1', endpointTemplateId: 'ollama-native', path: '/api/generate', wireFormat: 'ollama-generate' },
    ]);
  });

  it('does not invent authentication or an unverified Anthropic binding', () => {
    const contribution = PLUGIN_MANIFEST.contributes.providers[0];
    expect(contribution).not.toHaveProperty('credential');
    expect(contribution.endpointTemplates.map((entry) => entry.protocol)).not.toContain('anthropic');
  });
});
