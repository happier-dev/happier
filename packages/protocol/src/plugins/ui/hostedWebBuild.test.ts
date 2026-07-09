import { describe, expect, it } from 'vitest';

import {
  PluginHostedWebRuntimeModeV1Schema,
  buildPluginHostedWebStaticAssetPreviewId,
} from './hostedWebBuild.js';

describe('hosted-web build and serving metadata', () => {
  it('models static assets and session endpoints without requiring managed local services', () => {
    expect(PluginHostedWebRuntimeModeV1Schema.parse({
      kind: 'installedStaticAssets',
      artifactId: 'artifact-preview-web',
      assetRootId: 'preview-web',
    })).toMatchObject({ kind: 'installedStaticAssets' });

    expect(PluginHostedWebRuntimeModeV1Schema.parse({
      kind: 'registeredSessionEndpoint',
      endpointIdPath: '/endpoints/preview/id',
    })).toMatchObject({ kind: 'registeredSessionEndpoint' });
  });

  it('builds session and machine scoped static asset preview ids', () => {
    expect(buildPluginHostedWebStaticAssetPreviewId({
      pluginId: 'acme docs',
      contributionId: 'panel/main',
      sessionId: 'session 1',
      machineId: 'machine 1',
    })).toBe('plugin-static:acme-docs:panel-main:session-1:machine-1');
  });
});
