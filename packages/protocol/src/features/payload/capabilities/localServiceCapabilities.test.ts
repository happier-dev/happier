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
    });
    expect(FeatureGatesSchema.parse({
      localServices: { enabled: true, inventory: { enabled: true }, managed: { enabled: true } },
    }).localServices.managed.enabled).toBe(true);
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
});
