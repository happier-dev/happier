import { describe, expect, it } from 'vitest';

import {
  PluginUiActionDescriptorV1Schema,
  isExecutablePluginUiFallbackRefV1,
} from './actions.js';

describe('plugin UI action descriptors', () => {
  it('accepts typed host-owned surface actions', () => {
    const result = PluginUiActionDescriptorV1Schema.safeParse({
      id: 'open-preview',
      labelKey: 'preview.open',
      kind: 'openSurface',
      target: { surfaceId: 'preview-pane' },
    });

    expect(result.success).toBe(true);
  });

  it('rejects arbitrary command payloads in action targets', () => {
    const result = PluginUiActionDescriptorV1Schema.safeParse({
      id: 'run-command',
      labelKey: 'preview.run',
      kind: 'executeAction',
      target: {
        commandLine: 'rm -rf /tmp/example',
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects raw external URLs without host policy mediation', () => {
    const result = PluginUiActionDescriptorV1Schema.safeParse({
      id: 'open-docs',
      labelKey: 'preview.docs',
      kind: 'openExternal',
      target: {
        url: 'https://example.com/docs',
      },
    });

    expect(result.success).toBe(false);
  });

  it('distinguishes executable-tier fallbacks from unavailable markers', () => {
    expect(isExecutablePluginUiFallbackRefV1({ kind: 'hostedWeb', contributionId: 'preview-web' })).toBe(true);
    expect(isExecutablePluginUiFallbackRefV1({ kind: 'descriptor', descriptorId: 'preview-card' })).toBe(true);
    expect(isExecutablePluginUiFallbackRefV1({
      kind: 'structuredMessage',
      descriptorId: 'preview-message',
    })).toBe(true);
    expect(isExecutablePluginUiFallbackRefV1({ kind: 'unavailable' })).toBe(false);
    expect(isExecutablePluginUiFallbackRefV1({ kind: 'none' })).toBe(false);
    expect(isExecutablePluginUiFallbackRefV1(undefined)).toBe(false);
  });
});
