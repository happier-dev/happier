import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from '../v2.js';
import { PluginSurfaceRendererRefV1Schema } from './surfacePlacements.js';
import { PluginUiRendererFamilyV1Schema } from './renderers.js';

const display = {
  titleKey: 'title',
  descriptionKey: 'description',
  iconToken: 'browser',
  tone: 'info',
} as const;
const EMBEDDED_DIGEST = `sha256:${'e'.repeat(64)}`;

const embeddedWebBundle = {
  id: 'embedded-preview',
  bundle: {
    platform: 'web',
    channel: 'internal',
    assetPath: 'embedded-web/embedded-preview/entry.mjs',
    integrity: { digest: EMBEDDED_DIGEST },
  },
  entry: { mechanism: 'hostRuntimeFactoryV1' },
  compatibility: {
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    hostAppVersion: '2.0.0',
    supportedPlatforms: ['web'],
    supportedChannels: ['internal'],
  },
  hostApi: { minVersion: '1.0.0', methods: ['surface.read'] },
  fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
  display,
} as const;

describe('embedded web bundle contribution descriptors', () => {
  it('accepts embedded web bundle descriptors as a distinct contribution family', () => {
    const parsed = PluginContributesV2Schema.parse({
      embeddedWebBundles: [embeddedWebBundle],
    });

    expect(parsed.embeddedWebBundles[0]?.entry.mechanism).toBe('hostRuntimeFactoryV1');
    expect(parsed.embeddedWebBundles[0]?.bundle.platform).toBe('web');
  });

  it('accepts embedded web bundle surface renderer refs without overloading hosted-web or RN refs', () => {
    expect(PluginSurfaceRendererRefV1Schema.parse({
      kind: 'embeddedWeb',
      contributionId: 'embedded-preview',
      fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
    })).toEqual({
      kind: 'embeddedWeb',
      contributionId: 'embedded-preview',
      fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
    });
    expect(PluginUiRendererFamilyV1Schema.parse('embeddedWeb')).toBe('embeddedWeb');
  });

  it('fails closed for non-web platforms, wildcard runtime versions, and non-executable fallbacks', () => {
    const result = PluginContributesV2Schema.safeParse({
      embeddedWebBundles: [{
        ...embeddedWebBundle,
        bundle: {
          ...embeddedWebBundle.bundle,
          platform: 'ios',
        },
        compatibility: {
          ...embeddedWebBundle.compatibility,
          reactVersion: '*',
          supportedPlatforms: ['ios'],
        },
        fallback: { kind: 'none' },
      }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issuePaths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(issuePaths).toContain('embeddedWebBundles.0.bundle.platform');
      expect(issuePaths).toContain('embeddedWebBundles.0.compatibility.reactVersion');
      expect(issuePaths.some((path) => path.startsWith('embeddedWebBundles.0.fallback'))).toBe(true);
    }
  });

  it('allows local development hot-reload bundle declarations without immutable artifact integrity', () => {
    const parsed = PluginContributesV2Schema.parse({
      embeddedWebBundles: [{
        ...embeddedWebBundle,
        bundle: {
          platform: 'web',
          channel: 'development',
        },
        compatibility: {
          ...embeddedWebBundle.compatibility,
          supportedChannels: ['development'],
        },
        policy: { allowDevHotReload: true },
      }],
    });

    expect(parsed.embeddedWebBundles[0]?.bundle).toEqual({
      platform: 'web',
      channel: 'development',
    });
  });

  it('requires immutable installed bundle declarations to carry integrity', () => {
    const result = PluginContributesV2Schema.safeParse({
      embeddedWebBundles: [{
        ...embeddedWebBundle,
        bundle: {
          platform: 'web',
          channel: 'internal',
          assetPath: 'embedded-web/embedded-preview/entry.mjs',
        },
      }],
    });

    expect(result.success).toBe(false);
  });
});
