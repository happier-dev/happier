import { describe, expect, it } from 'vitest';

import {
  PLUGIN_UI_HOST_API_VERSION_V1,
  PluginUiHostApiAvailabilityV1Schema,
  PluginUiHostApiMethodV1Schema,
  PluginUiHostApiRequirementV1Schema,
} from './hostApi.js';

describe('plugin UI host API contract', () => {
  it('defines one shared method vocabulary for every plugin UI tier', () => {
    expect(PluginUiHostApiMethodV1Schema.options).toEqual([
      'getSurfaceContext',
      'requestSessionResource',
      'subscribeResource',
      'unsubscribeResource',
      'dispatchAction',
      'openSurface',
      'logDiagnostic',
      'copy',
      'openExternal',
    ]);

    expect(PluginUiHostApiRequirementV1Schema.parse({
      minVersion: PLUGIN_UI_HOST_API_VERSION_V1,
      methods: ['requestSessionResource', 'subscribeResource', 'unsubscribeResource'],
    })).toEqual({
      minVersion: '1.0.0',
      methods: ['requestSessionResource', 'subscribeResource', 'unsubscribeResource'],
    });
  });

  it('fails closed for undeclared methods and preserves unavailable diagnostics', () => {
    expect(PluginUiHostApiAvailabilityV1Schema.parse({
      version: PLUGIN_UI_HOST_API_VERSION_V1,
      methods: ['requestSessionResource'],
      state: 'unavailable',
      diagnostics: ['feature_disabled'],
    })).toMatchObject({
      state: 'unavailable',
      diagnostics: ['feature_disabled'],
    });

    expect(PluginUiHostApiAvailabilityV1Schema.safeParse({
      version: PLUGIN_UI_HOST_API_VERSION_V1,
      methods: ['rawStoreAccess'],
      state: 'available',
    }).success).toBe(false);
  });
});
