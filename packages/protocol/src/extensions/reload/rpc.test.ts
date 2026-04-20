import { describe, expect, it } from 'vitest';

import {
  ExtensionReloadRequestV1Schema,
  ExtensionReloadResponseV1Schema,
  RPC_METHODS,
} from '../../index.js';

describe('extension reload rpc contracts', () => {
  it('exposes daemon extension reload RPC method names and payload schemas', () => {
    expect(RPC_METHODS.DAEMON_EXTENSIONS_RELOAD).toBe('daemon.extensions.reload');
    expect(RPC_METHODS.DAEMON_EXTENSIONS_RELOAD_STATUS).toBe('daemon.extensions.reload.status');

    const request = ExtensionReloadRequestV1Schema.parse({
      pluginId: 'acme.extension',
      reason: 'developer',
    });
    expect(request.pluginId).toBe('acme.extension');
    expect(request.reason).toBe('developer');

    const response = ExtensionReloadResponseV1Schema.parse({
      ok: true,
      generation: 2,
      changedPluginIds: ['acme.extension'],
      diagnostics: [],
    });
    expect(response.generation).toBe(2);
    expect(response.changedPluginIds).toEqual(['acme.extension']);
  });

  it('rejects undeclared executable internals in reload wire payloads', () => {
    expect(ExtensionReloadRequestV1Schema.safeParse({
      pluginId: 'acme.extension',
      reason: 'developer',
      daemonModulePath: '/tmp/acme/daemon.js',
    }).success).toBe(false);

    expect(ExtensionReloadResponseV1Schema.safeParse({
      ok: true,
      generation: 2,
      changedPluginIds: ['acme.extension'],
      diagnostics: [
        {
          severity: 'info',
          code: 'extension.reload.started',
          message: 'Reload started',
          handler: {
            target: 'daemon',
            exportName: 'reloadAcme',
          },
        },
      ],
    }).success).toBe(false);
  });
});
