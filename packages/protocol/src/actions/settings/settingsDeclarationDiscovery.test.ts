import { describe, expect, it } from 'vitest';
import { SettingsDeclarationActionOutputSchemasV1, type SettingsDeclarationDescriptorV1 } from '../settingsDeclarationActionFamily.js';
import { projectSettingsDeclarationDiscoveryV1 } from './settingsDeclarationDiscovery.js';

describe('settings declaration discovery delivery', () => {
  const items: SettingsDeclarationDescriptorV1[] = ['one', 'two'].map(anchor => ({
    anchor, pageId: 'appearance', title: `Café ${anchor} 🎨`, description: 'Quotes " and backslashes \\ stay intact',
    readable: true, writable: true, sensitive: false, allowedValues: ['adaptive', 'light', 'dark'],
  }));

  it('preserves full descriptors at the exact UTF-8 boundary and resumes without loss', () => {
    const maxBytes = Buffer.byteLength(JSON.stringify({ items: [items[0]], total: items.length, nextCursor: 1 }));
    const first = projectSettingsDeclarationDiscoveryV1(items, { maxBytes });
    expect(first).toEqual({ items: [items[0]], total: 2, nextCursor: 1 });
    expect(SettingsDeclarationActionOutputSchemasV1['settings.list'].parse(first)).toEqual(first);
    expect(Buffer.byteLength(JSON.stringify(first))).toBe(maxBytes);
    const second = projectSettingsDeclarationDiscoveryV1(items, { maxBytes, cursor: 1 });
    expect(second).toEqual({ items: [items[1]], total: 2 });
    expect(projectSettingsDeclarationDiscoveryV1(items, {})).toEqual({ items });
    expect(projectSettingsDeclarationDiscoveryV1([], { maxBytes })).toEqual({ items: [], total: 0 });
  });

  it('names an insufficient budget instead of truncating a declaration or returning a non-advancing cursor', () => {
    const minimumBytes = Buffer.byteLength(JSON.stringify({ items: [items[0]], total: items.length, nextCursor: 1 }));
    expect(projectSettingsDeclarationDiscoveryV1(items, { maxBytes: minimumBytes - 1 })).toEqual({
      ok: false, errorCode: 'settings_discovery_budget_too_small', error: 'settings_discovery_budget_too_small',
      details: { minimumBytes },
    });
    const emptyBytes = Buffer.byteLength(JSON.stringify({ items: [], total: 0 }));
    expect(projectSettingsDeclarationDiscoveryV1([], { maxBytes: emptyBytes - 1 })).toMatchObject({
      ok: false, errorCode: 'settings_discovery_budget_too_small', details: { minimumBytes: emptyBytes },
    });
  });
});
