import { describe, expect, it } from 'vitest';

import { PluginSessionHeaderActionDescriptorV1Schema } from '../../index.js';
import {
  PluginUiResolvedSemanticCommandV1Schema,
  PluginUiSemanticCommandV1Schema,
} from './index.js';

describe('plugin-UI public subpath initialization', () => {
  it('initializes the root contribution descriptor and the public UI semantic-action schema together', () => {
    expect(PluginSessionHeaderActionDescriptorV1Schema.parse({
      id: 'open-activity',
      title: 'Open activity',
      action: {
        kind: 'openSurface',
        destination: 'activity',
      },
    })).toMatchObject({
      action: {
        kind: 'openSurface',
        destination: 'activity',
      },
    });
    expect(PluginUiSemanticCommandV1Schema.parse({
      kind: 'executeAction',
      action: 'refresh',
    })).toEqual({
      kind: 'executeAction',
      action: 'refresh',
    });
    expect(PluginUiResolvedSemanticCommandV1Schema.parse({
      kind: 'executeAction',
      action: { pluginId: 'acme.navigation', localId: 'refresh' },
    })).toEqual({
      kind: 'executeAction',
      action: { pluginId: 'acme.navigation', localId: 'refresh' },
    });
  });
});
