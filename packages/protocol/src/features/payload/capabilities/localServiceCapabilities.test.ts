import { describe, expect, it } from 'vitest';

import { FEATURE_CATALOG, FEATURE_IDS } from '../../catalog.js';
import { CapabilitiesSchema } from './capabilitiesSchema.js';
import { FeatureGatesSchema } from '../featureGatesSchema.js';

describe('local service feature gates and capabilities', () => {
  it('declares inventory and managed feature ids with dependency ordering', () => {
    expect(FEATURE_IDS).toContain('localServices.inventory');
    expect(FEATURE_IDS).toContain('localServices.managed');
    expect(FEATURE_CATALOG['localServices.managed'].dependencies).toContain('localServices.inventory');
  });

  it('defaults local service gates to disabled and parses enabled payloads', () => {
    expect(FeatureGatesSchema.parse({}).localServices).toMatchObject({
      enabled: false,
      inventory: { enabled: false },
      managed: { enabled: false },
      preview: { enabled: false },
      publicPreview: { enabled: false },
      launcher: { enabled: false },
      actions: { enabled: false, terminate: { enabled: false } },
    });
    expect(FeatureGatesSchema.parse({
      localServices: {
        enabled: true,
        inventory: { enabled: true },
        managed: { enabled: true },
        launcher: { enabled: true },
        actions: { enabled: true, terminate: { enabled: false } },
      },
    }).localServices.launcher.enabled).toBe(true);
  });

  it('exposes local service capability limits and redaction guarantees', () => {
    const parsed = CapabilitiesSchema.parse({
      localServices: {
        inventory: {
          supportedPlatforms: ['darwin', 'linux'],
          processProvenance: true,
          workspaceProvenance: true,
          classifier: true,
          pageTitleEnrichment: {
            enabled: true,
            timeoutMs: 650,
            maxBodyBytes: 131_072,
            concurrency: 4,
            successTtlMs: 30_000,
            failureTtlMs: 10_000,
          },
          redactsProcessArgs: true,
        },
        managed: {
          enabled: true,
          supportedRestartPolicies: ['never'],
          portRange: { start: 50_000, end: 55_000 },
          maxServicesPerOwner: 8,
          localNameDomain: 'localhost',
        },
      },
    });

    expect(parsed.localServices.inventory.redactsProcessArgs).toBe(true);
    expect(parsed.localServices.managed.portRange).toEqual({ start: 50_000, end: 55_000 });
  });

  it('exposes launcher capability details without using capabilities as gates', () => {
    expect(CapabilitiesSchema.parse({}).localServices.launcher).toMatchObject({
      supportedSources: [],
      scriptDiscovery: {
        enabled: false,
        maxDepth: 4,
        maxScripts: 50,
      },
      recentHistory: {
        enabled: false,
        maxEntries: 20,
      },
      launchActionsEnabled: false,
    });

    const parsed = CapabilitiesSchema.parse({
      localServices: {
        launcher: {
          supportedSources: ['package_script', 'inventory_entry', 'registered_preview'],
          scriptDiscovery: { enabled: true, maxDepth: 3, maxScripts: 12 },
          recentHistory: { enabled: true, maxEntries: 8 },
          launchActionsEnabled: true,
        },
      },
    });

    expect(parsed.localServices.launcher.supportedSources).toEqual([
      'package_script',
      'inventory_entry',
      'registered_preview',
    ]);
    expect(parsed.localServices.launcher.scriptDiscovery.maxScripts).toBe(12);
    expect(parsed.localServices.launcher.recentHistory.maxEntries).toBe(8);
  });

  it('exposes safe local-service action capability defaults', () => {
    expect(CapabilitiesSchema.parse({}).localServices.actions).toMatchObject({
      supportedKinds: ['copy_url', 'open_preview', 'forget'],
      terminate: {
        enabled: false,
        gracefulTimeoutMs: 5_000,
        verificationTimeoutMs: 10_000,
        forceAllowed: false,
      },
    });

    const parsed = CapabilitiesSchema.parse({
      localServices: {
        actions: {
          supportedKinds: ['copy_url', 'open_preview', 'stop_managed'],
          terminate: {
            enabled: true,
            gracefulTimeoutMs: 7_500,
            verificationTimeoutMs: 12_000,
            forceAllowed: true,
          },
        },
      },
    });

    expect(parsed.localServices.actions.supportedKinds).toEqual(['copy_url', 'open_preview', 'stop_managed']);
    expect(parsed.localServices.actions.terminate).toMatchObject({
      enabled: true,
      gracefulTimeoutMs: 7_500,
      verificationTimeoutMs: 12_000,
      forceAllowed: true,
    });
  });

  it('describes public preview WebSocket support separately from private preview support', () => {
    expect(CapabilitiesSchema.parse({}).localServices.publicPreview.webSocketSupport).toBe(false);

    const parsed = CapabilitiesSchema.parse({
      localServices: {
        publicPreview: {
          enabled: true,
          webSocketSupport: true,
        },
      },
    });

    expect(parsed.localServices.publicPreview.webSocketSupport).toBe(true);
  });

  it('declares preview diagnostics support as capability details with fail-closed defaults', () => {
    expect(CapabilitiesSchema.parse({}).localServices.preview.diagnostics).toMatchObject({
      enabled: false,
      available: false,
      supportedReasonCodes: [],
      pmsProjection: false,
      publicPreviewProjection: false,
      disabledReasons: ['observability_unavailable'],
    });

    const parsed = CapabilitiesSchema.parse({
      localServices: {
        preview: {
          enabled: true,
          diagnostics: {
            enabled: true,
            available: true,
            supportedReasonCodes: ['path_mode_degraded', 'cookie_stripped', 'pms_observability_unavailable'],
            pmsProjection: true,
            publicPreviewProjection: true,
            disabledReasons: [],
          },
        },
      },
    });

    expect(parsed.localServices.preview.diagnostics).toMatchObject({
      enabled: true,
      available: true,
      supportedReasonCodes: ['path_mode_degraded', 'cookie_stripped', 'pms_observability_unavailable'],
      pmsProjection: true,
      publicPreviewProjection: true,
      disabledReasons: [],
    });
  });
});
