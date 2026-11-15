import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('brand mark', () => {
  it('declares its packaged brand mark through the generic brand Resource', () => {
    expect(PLUGIN_MANIFEST.brand).toEqual({ iconResourceId: 'brand-icon', monochrome: true });
    expect(PLUGIN_MANIFEST.contributes.resources?.filter(({ id }) => id === 'brand-icon')).toEqual([{ id: 'brand-icon', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }]);
    const asset = readFileSync(new URL('../assets/brand.png', import.meta.url));
    expect([...asset.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(asset.readUInt32BE(16)).toBe(asset.readUInt32BE(20));
  });
});

describe('native process disclosure', () => {
  it('offers only the two local variants for controller-local Session placement', () => {
    const local = PLUGIN_MANIFEST.contributes.machineProvisioners?.filter(
      provisioner => provisioner.sessionPlacement?.kind === 'controller-local');
    expect(local?.map(provisioner => provisioner.id).sort()).toEqual(['local-sandbox', 'local-space']);
    // These launch schemas include unprivileged containers; they make no
    // blanket promise that an Agent can nest its native sandbox inside them.
    expect(local?.every(provisioner => provisioner.sessionPlacement?.supportsAgentNativeSandbox === false)).toBe(true);
  });
  it('places both native cloud account choices in the cloud-machine setup category', () => {
    expect(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors).toMatchObject([
      { id: 'cloud-native', ui: { category: 'cloud-machines' } },
      { id: 'cua-account', ui: { category: 'cloud-machines' } },
    ]);
  });
  it('declares the HOME value supplied to every Cua process', () => {
    expect(PLUGIN_MANIFEST.hostAccess?.required).toContainEqual(expect.objectContaining({
      capability: 'process',
      scope: expect.objectContaining({ envKeys: ['HOME'] }),
    }));
  });
});


it('declares saved CPU, memory and disk dimensions through the options Action', () => {
  const fields = PLUGIN_MANIFEST.contributes.actions?.flatMap(action => action.inputHints?.fields ?? []) ?? [];
  for (const role of ['cpu', 'memory', 'disk']) expect(fields).toContainEqual(expect.objectContaining({ role }));
});
