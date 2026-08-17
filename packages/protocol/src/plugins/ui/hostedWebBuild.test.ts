import { describe, expect, it } from 'vitest';

import {
  PluginHostedWebRuntimeModeV1Schema,
  buildPluginHostedWebStaticAssetPreviewId,
} from './hostedWebBuild.js';
import { PluginHostedWebContributionV1Schema } from '../contributions/ui/hostedWeb.js';

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

    expect(PluginHostedWebRuntimeModeV1Schema.safeParse({
      kind: 'managedLocalService',
      localServiceId: 'retired-dev-server',
    }).success).toBe(false);

    const hostedWebContribution = {
      id: 'retired-managed-hosted-web',
      service: { kind: 'staticAssets', assetRootId: 'preview-web' },
      entry: { routeMode: 'pathFallback' },
      bridge: { allowedMessages: [] },
      display: { titleKey: 'plugin.preview.title' },
      sandbox: {},
      security: {},
      fallback: { kind: 'descriptor', descriptorId: 'fallback' },
    } as const;
    expect(PluginHostedWebContributionV1Schema.safeParse(hostedWebContribution).success).toBe(true);
    expect(PluginHostedWebContributionV1Schema.safeParse({
      ...hostedWebContribution,
      service: { kind: 'managedService', serviceId: 'retired-dev-server' },
    }).success).toBe(false);
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
