import { describe, expect, it } from 'vitest';

import {
  PluginProjectionBrandAssetV2Schema,
  PluginProjectionInstalledPackageV2Schema,
} from './contributionRegistryProjection.js';

describe('portable plugin brand projection (wire)', () => {
  it('admits only a verified immutable Resource fact or a neutral fallback', () => {
    const available = {
      state: 'available',
      resource: { pluginId: 'acme.brand', localId: 'brand-icon' },
      width: 64,
      height: 64,
      digest: `sha256:${'a'.repeat(64)}`,
    } as const;

    expect(PluginProjectionBrandAssetV2Schema.parse(available)).toEqual(available);
    expect(PluginProjectionInstalledPackageV2Schema.parse({
      id: 'acme.brand',
      displayName: 'Acme Brand',
      version: '1.0.0',
      enabled: true,
      source: { kind: 'archive', locator: 'acme.brand.tgz' },
      brand: available,
    }).brand).toEqual(available);
    expect(PluginProjectionBrandAssetV2Schema.parse({ state: 'missing' })).toEqual({ state: 'missing' });
    expect(PluginProjectionBrandAssetV2Schema.parse({ state: 'invalid' })).toEqual({ state: 'invalid' });
    expect(PluginProjectionBrandAssetV2Schema.parse({ state: 'retired' })).toEqual({ state: 'retired' });

    expect(PluginProjectionBrandAssetV2Schema.safeParse({
      ...available,
      height: 65,
    }).success).toBe(false);
    expect(PluginProjectionBrandAssetV2Schema.safeParse({
      ...available,
      url: 'https://icons.example/acme.png',
    }).success).toBe(false);
    expect(PluginProjectionBrandAssetV2Schema.safeParse({
      state: 'available',
      resource: { pluginId: 'acme.brand', localId: 'brand-icon' },
      width: 64,
      height: 64,
      digest: `sha256:${'a'.repeat(64)}`,
      bytesBase64: 'secret-image-bytes',
    }).success).toBe(false);
  });
});
