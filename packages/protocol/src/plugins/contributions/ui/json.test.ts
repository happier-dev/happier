import { describe, expect, it } from 'vitest';

import { PluginHostedWebBridgeEnvelopeV1Schema } from '../../ui/hostedWebBridge.js';
import {
  PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1,
  PluginUiLaunchInputV1Schema,
} from '../../ui/semanticCommands.js';
import { PluginUiJsonValueV1Schema } from './json.js';

function nestedArray(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}

function hostedBridgeEnvelope(payload: unknown): unknown {
  return {
    version: 1,
    pluginId: 'acme.preview',
    contributionId: 'preview-web',
    surfaceId: 'sessionSurface:acme.preview:preview-pane',
    nonce: 'nonce-1',
    sequence: 1,
    kind: 'ready',
    payload,
  };
}

describe('PluginUiJsonValueV1Schema', () => {
  it('handles deeply nested ordinary JSON without a public traversal quota', () => {
    const deep = nestedArray(12_000);
    let result: { success: boolean } | undefined;
    let launchInputResult: { success: boolean } | undefined;

    expect(() => {
      result = PluginUiJsonValueV1Schema.safeParse(deep);
    }).not.toThrow();
    expect(result?.success).toBe(true);

    expect(() => {
      launchInputResult = PluginUiLaunchInputV1Schema.safeParse(deep);
    }).not.toThrow();
    expect(launchInputResult?.success).toBe(false);
  });

  it('does not use generic string or collection ceilings for ordinary JSON', () => {
    expect(PluginUiJsonValueV1Schema.safeParse('x'.repeat(192 * 1024 + 1)).success).toBe(true);
    expect(PluginUiJsonValueV1Schema.safeParse(
      Array.from({ length: 8_193 }, () => null),
    ).success).toBe(true);
  });

  it('uses the launch-input UTF-8 byte ceiling exactly', () => {
    const jsonStringOverhead = new TextEncoder().encode(JSON.stringify('')).byteLength;
    const utf8ThreeByteCharacter = '€';
    const utf8ThreeByteLength = new TextEncoder().encode(utf8ThreeByteCharacter).byteLength;
    const atByteLimit = utf8ThreeByteCharacter.repeat(
      (PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1 - jsonStringOverhead) / utf8ThreeByteLength,
    );
    const overByteLimit = `${atByteLimit}a`;

    expect(PluginUiLaunchInputV1Schema.safeParse(atByteLimit).success).toBe(true);
    expect(PluginUiLaunchInputV1Schema.safeParse(overByteLimit).success).toBe(false);
  });

  it('rejects accessors, cycles, and non-plain objects without throwing', () => {
    let accessorRead = false;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return 'must not be read';
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    class NonPlainValue {
      readonly value = 'must not be accepted';
    }

    for (const value of [
      accessor,
      cyclic,
      new NonPlainValue(),
      new Date(),
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      let result: { success: boolean } | undefined;
      expect(() => {
        result = PluginUiJsonValueV1Schema.safeParse(value);
      }).not.toThrow();
      expect(result?.success).toBe(false);
      expect(PluginUiLaunchInputV1Schema.safeParse(value).success).toBe(false);
    }
    expect(accessorRead).toBe(false);
  });

  it('keeps ordinary JSON values valid', () => {
    const value = {
      nested: [null, true, 7, 'selection'],
      metadata: Object.assign(Object.create(null) as Record<string, unknown>, { id: 'preview' }),
    };

    const parsed = PluginUiJsonValueV1Schema.safeParse(value);
    expect(parsed).toMatchObject({ success: true });
    if (parsed.success) expect(parsed.data).toBe(value);
  });

  it('keeps hosted-web bridge parsing stack-safe for deep postMessage data', () => {
    const deepEnvelope = hostedBridgeEnvelope(nestedArray(12_000));
    let result: { success: boolean } | undefined;

    expect(() => {
      result = PluginHostedWebBridgeEnvelopeV1Schema.safeParse(deepEnvelope);
    }).not.toThrow();
    expect(result?.success).toBe(true);
  });
});
