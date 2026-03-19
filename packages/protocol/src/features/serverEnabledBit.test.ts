import { describe, expect, it } from 'vitest';

import { FeaturesResponseSchema } from '../features.js';
import { FEATURE_IDS } from './featureIds.js';
import { FEATURE_CATALOG } from './catalog.js';
import { readServerEnabledBit, resolveServerEnabledBitPath, tryWriteServerEnabledBitInPlace } from './serverEnabledBit.js';

describe('server enabled bit helpers', () => {
  it('derives the enabled-bit path from FeatureId', () => {
    expect(resolveServerEnabledBitPath('social.friends')).toEqual(['features', 'social', 'friends', 'enabled']);
    expect(resolveServerEnabledBitPath('updates.ota')).toEqual(['features', 'updates', 'ota', 'enabled']);
    expect(resolveServerEnabledBitPath('attachments.uploads')).toEqual(['features', 'attachments', 'uploads', 'enabled']);
    expect(resolveServerEnabledBitPath('machines.transfer.directPeer')).toEqual([
      'features',
      'machines',
      'transfer',
      'directPeer',
      'enabled',
    ]);
    expect(resolveServerEnabledBitPath('machines.transfer.serverRouted')).toEqual([
      'features',
      'machines',
      'transfer',
      'serverRouted',
      'enabled',
    ]);
  });

  it('reads enabled bits for server-represented features and returns null for non-represented features', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        social: { friends: { enabled: true } },
        updates: { ota: { enabled: false } },
        machines: {
          enabled: true,
          transfer: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: false } },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'social.friends')).toBe(true);
    expect(readServerEnabledBit(parsed, 'updates.ota')).toBe(false);
    expect(readServerEnabledBit(parsed, 'machines.transfer.directPeer')).toBe(true);
    expect(readServerEnabledBit(parsed, 'machines.transfer.serverRouted')).toBe(false);
    expect(readServerEnabledBit(parsed, 'execution.runs')).toBeNull();
  });

  it('writes enabled bits in place when the derived path exists and is boolean', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        social: { friends: { enabled: true } },
      },
      capabilities: {},
    });

    expect(tryWriteServerEnabledBitInPlace(parsed, 'social.friends', false)).toBe(true);
    expect(readServerEnabledBit(parsed, 'social.friends')).toBe(false);

    expect(tryWriteServerEnabledBitInPlace(parsed, 'execution.runs', false)).toBe(false);
  });

  it('supports enabled-bit paths for every server-represented catalog feature', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {},
      capabilities: {},
    });

    for (const featureId of FEATURE_IDS) {
      const entry = FEATURE_CATALOG[featureId];
      const enabled = readServerEnabledBit(parsed, featureId);
      if (entry.representation === 'server') {
        expect(typeof enabled).toBe('boolean');
      } else {
        expect(enabled === null || typeof enabled === 'boolean').toBe(true);
      }
    }
  });
});
