import { describe, expect, it, vi } from 'vitest';

import type { PluginContextV1 } from '@happier-dev/plugin-sdk';

import { createOpenCodeHandoffSurface } from './descriptor.js';

function encodeExportPayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function createPluginContextFixture(execRun: PluginContextV1['exec']['run']): PluginContextV1 {
  return {
    exec: {
      run: execRun,
      systemTools: { resolve: vi.fn() },
    },
  } as unknown as PluginContextV1;
}

describe('createOpenCodeHandoffSurface', () => {
  it('returns canonical session-state updates for imported OpenCode sessions', async () => {
    const execRun = vi.fn(async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }));
    const surface = createOpenCodeHandoffSurface(createPluginContextFixture(execRun));

    const result = await surface.importBundle({
      bundle: {
        providerId: 'opencode',
        remoteSessionId: 'oc-import-1',
        exportJsonBase64: encodeExportPayload({ id: 'oc-import-1' }),
        affinity: {
          backendMode: 'server',
          serverBaseUrl: 'http://127.0.0.1:4096/',
          serverBaseUrlExplicit: true,
        },
      },
      targetDirectory: '/repo',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        providerSessionId: 'oc-import-1',
        launch: {
          directory: '/repo',
          sessionStateUpdates: [
            {
              fieldId: 'identity.runtimeDescriptor',
              value: {
                v: 1,
                providerId: 'opencode',
                provider: {
                  backendMode: 'server',
                  providerSessionId: 'oc-import-1',
                  providerExtra: {
                    runtimeHandle: {
                      backendMode: 'server',
                      providerSessionId: 'oc-import-1',
                      serverBaseUrl: 'http://127.0.0.1:4096/',
                      serverBaseUrlExplicit: true,
                    },
                  },
                },
              },
            },
            {
              fieldId: 'identity.providerSessionId',
              value: 'oc-import-1',
            },
          ],
        },
      },
    });
  });
});
