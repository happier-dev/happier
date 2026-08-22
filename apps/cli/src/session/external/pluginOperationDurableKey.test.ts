import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { deriveExternalSessionPluginOperationDurableKey } from './pluginOperationDurableKey';

describe('External Sessions plugin operation durable key', () => {
  it('is stable for one plugin principal and raw key while separating plugins', () => {
    const input = {
      pluginId: 'plugin.alpha',
      callerKey: 'caller-key',
    };
    const takeover = deriveExternalSessionPluginOperationDurableKey(input);

    expect(takeover).toMatch(
      /^plugin-operation:v1:[0-9a-f]{64}$/,
    );
    expect(takeover).toBe(
      'plugin-operation:v1:085981fd2751f84d1877e0f1a6205315e66409a5f0f3d557b8b8f344651f6d35',
    );
    expect(deriveExternalSessionPluginOperationDurableKey(input)).toBe(
      takeover,
    );
    expect(deriveExternalSessionPluginOperationDurableKey({
      ...input,
      pluginId: 'plugin.beta',
    })).not.toBe(takeover);
  });

  it('distinguishes opaque lone-surrogate keys from each other and U+FFFD', () => {
    const derive = (callerKey: string) =>
      deriveExternalSessionPluginOperationDurableKey({
        pluginId: 'plugin.alpha',
        callerKey,
      });

    const loneHighSurrogate = derive('\uD800');
    expect(derive('\uD800')).toBe(loneHighSurrogate);
    expect(new Set([
      loneHighSurrogate,
      derive('\uD801'),
      derive('\uDC00'),
      derive('\uFFFD'),
    ])).toHaveProperty('size', 4);
  });

  it('preserves the legacy UTF-8 derivation for well-formed surrogate pairs', () => {
    expect(deriveExternalSessionPluginOperationDurableKey({
      pluginId: 'plugin.alpha',
      callerKey: 'a😀z',
    })).toBe(
      'plugin-operation:v1:ea1cfe33b65a2f4e05718ce5e7e9ea7c93d7f3c620b161430fec8309205420e0',
    );
  });

  it('accepts exact nonempty trim-equal caller keys through 256 code units', () => {
    for (const callerKey of ['k', 'x'.repeat(256)]) {
      expect(deriveExternalSessionPluginOperationDurableKey({
        pluginId: 'plugin.alpha',
        callerKey,
      })).toMatch(/^plugin-operation:v1:[0-9a-f]{64}$/);
    }
  });

  it('rejects noncanonical principals and caller keys', () => {
    const invalidInputs = [
      { pluginId: ' plugin.alpha', callerKey: 'key' },
      { pluginId: 'plugin.alpha', callerKey: '' },
      { pluginId: 'plugin.alpha', callerKey: ' key' },
      {
        pluginId: 'plugin.alpha',
        callerKey: 'x'.repeat(257),
      },
    ];

    for (const input of invalidInputs) {
      expect(() => deriveExternalSessionPluginOperationDurableKey(
        input as Parameters<
          typeof deriveExternalSessionPluginOperationDurableKey
        >[0],
      )).toThrow(PluginError);
    }
  });
});
