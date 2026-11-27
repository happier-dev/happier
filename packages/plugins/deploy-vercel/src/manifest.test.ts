import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as entry from './index.js';

describe('Vercel deployment account consumption', () => {
  it('contributes a Vercel provider page to the existing Environment catalog', () => {
    const ui = entry.manifest.contributes?.ui;
    const page = ui?.views?.find(view => view.container === 'appPage' && view.target.kind === 'deploymentEnvironment');
    expect(page).toMatchObject({ id: 'environment-provider', renderer: 'environment-provider-native' });
    expect(ui?.renderers?.find(renderer => renderer.id === page?.renderer)).toMatchObject({
      kind: 'reactNative', artifact: 'environment-provider',
    });
  });

  it('uses the vendor account and offers no retired deployment connection', async () => {
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry });
    try {
      expect(entry.manifest.hostAccess?.required?.find(access => access.id === 'deploy.manage'))
        .toMatchObject({ capability: 'connectedAccounts', scope: {
          serviceRefs: [{ pluginId: 'happier.machine.vercel', localId: 'vercel-account' }],
          operations: ['use'], materializationKinds: ['httpHeaders', 'environment'],
        } });
      expect(entry.manifest.contributes?.connectedAccountDescriptors ?? []).toEqual([]);
      // Preparation has its own GET-only API grant; credential setup stays with the vendor owner.
      expect(entry.manifest.hostAccess?.required?.map(access => access.id)).toEqual(['vercel-api', 'deploy.manage']);
      expect(kit.registration('connectedAccountDescriptors', 'vercel')).toBeUndefined();
    } finally { await kit.dispose(); }
  });

  it('carries Vercel\'s mark as a packaged brand asset, inked like text', () => {
    expect(entry.manifest.brand).toEqual({ iconResourceId: 'brand-icon', monochrome: true });
    expect(entry.manifest.contributes?.resources?.find(resource => resource.id === 'brand-icon'))
      .toEqual({ id: 'brand-icon', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' });
  });
});
