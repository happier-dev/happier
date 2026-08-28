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
        source: 'probe',
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
  });

  it('does not invent authentication or an unverified Anthropic binding', () => {
    const contribution = PLUGIN_MANIFEST.contributes.providers[0];
    expect(contribution).not.toHaveProperty('credential');
    expect(contribution.endpointTemplates.map((entry) => entry.protocol)).not.toContain('anthropic');
  });
});
