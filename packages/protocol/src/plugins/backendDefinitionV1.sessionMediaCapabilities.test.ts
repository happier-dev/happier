import { describe, expect, it } from 'vitest';

import { PluginBackendCapabilitiesV1Schema } from './backendDefinitionV1.js';

describe('PluginBackendCapabilitiesV1Schema session media capabilities', () => {
  it('defaults session media capabilities to unsupported', () => {
    const parsed = PluginBackendCapabilitiesV1Schema.parse({});

    expect(parsed.session.media).toEqual({
      acceptsImageInput: { supported: false },
      emitsSessionMedia: { supported: false },
      nativeImageGeneration: { supported: false },
    });
  });

  it('distinguishes image input, session media output, and native image generation support', () => {
    const parsed = PluginBackendCapabilitiesV1Schema.parse({
      session: {
        media: {
          acceptsImageInput: { supported: true },
          emitsSessionMedia: {
            supported: true,
            mediaKinds: ['image'],
            sources: ['provider-generated', 'tool-output'],
            storage: 'session-media-file',
          },
          nativeImageGeneration: {
            supported: true,
            mediaKinds: ['image'],
            streamingPartials: false,
          },
        },
      },
    });

    expect(parsed.session.media.acceptsImageInput.supported).toBe(true);
    expect(parsed.session.media.emitsSessionMedia).toMatchObject({
      supported: true,
      mediaKinds: ['image'],
      sources: ['provider-generated', 'tool-output'],
      storage: 'session-media-file',
    });
    expect(parsed.session.media.nativeImageGeneration).toMatchObject({
      supported: true,
      mediaKinds: ['image'],
      streamingPartials: false,
    });
  });

  it('normalizes partial capability declarations with fail-closed session media defaults', async () => {
    const backendDefinitionModule = await import('./backendDefinitionV1.js') as typeof import('./backendDefinitionV1.js') & {
      normalizePluginBackendCapabilitiesV1?: (input: unknown) => unknown;
    };

    expect(backendDefinitionModule.normalizePluginBackendCapabilitiesV1).toEqual(expect.any(Function));

    expect(backendDefinitionModule.normalizePluginBackendCapabilitiesV1?.({
      executionRun: { supported: false },
    })).toEqual({
      executionRun: { supported: false },
      session: {
        media: {
          acceptsImageInput: { supported: false },
          emitsSessionMedia: { supported: false },
          nativeImageGeneration: { supported: false },
        },
      },
    });
  });
});
