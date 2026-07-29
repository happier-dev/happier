import { describe, expect, it } from 'vitest';

import type {
  PluginUiHostApiRequestEnvelopeV1,
  PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

import { createPluginSurfaceHostApi } from './createPluginSurfaceHostApi.js';

const surfaceContext: PluginUiSurfaceContextV1 = {
  pluginId: 'acme.preview',
  contributionId: 'preview-web',
  surfaceId: 'surface-1',
  placement: 'sessionPane',
  platform: 'web',
  channel: 'internal',
  resourceScope: [{ kind: 'session', idPath: '/context/sessionId' }],
  diagnostics: [],
};

function request(
  method: PluginUiHostApiRequestEnvelopeV1['method'],
  payload?: unknown,
): PluginUiHostApiRequestEnvelopeV1 {
  return {
    version: 1,
    requestId: `req:${method}`,
    surface: surfaceContext,
    method,
    payload: payload as PluginUiHostApiRequestEnvelopeV1['payload'],
  };
}

describe('createPluginSurfaceHostApi', () => {
  it('exposes the platform + channel from the surface context', () => {
    const hostApi = createPluginSurfaceHostApi({ surfaceContext });
    expect(hostApi.platform).toBe('web');
    expect(hostApi.channel).toBe('internal');
  });

  it('answers getSurfaceContext locally with the scope context (finding #10)', async () => {
    const hostApi = createPluginSurfaceHostApi({ surfaceContext });
    const result = await hostApi.handleRequest(request('getSurfaceContext'));
    expect(result).toMatchObject({
      pluginId: 'acme.preview',
      surfaceId: 'surface-1',
      resourceScope: [{ kind: 'session', idPath: '/context/sessionId' }],
    });
  });

  it('routes a method to its injected handler', async () => {
    const hostApi = createPluginSurfaceHostApi({
      surfaceContext,
      handlers: {
        copy: async () => ({ copied: true }),
      },
    });
    const result = await hostApi.handleRequest(request('copy', { valuePath: '/v' }));
    expect(result).toEqual({ copied: true });
  });

  it('fails closed with unavailable for an unhandled method', async () => {
    const hostApi = createPluginSurfaceHostApi({ surfaceContext });
    const result = await hostApi.handleRequest(request('dispatchAction', { actionId: 'x' }));
    expect(result).toMatchObject({ code: 'unavailable' });
  });

  it('delegates unhandled methods to the fallback when supplied', async () => {
    const hostApi = createPluginSurfaceHostApi({
      surfaceContext,
      handlers: { copy: async () => ({ copied: true }) },
      fallback: async (req) => ({ fellBackFor: req.method }),
    });
    const result = await hostApi.handleRequest(request('openExternal', { urlPath: '/u' }));
    expect(result).toEqual({ fellBackFor: 'openExternal' });
  });

  it('still answers getSurfaceContext locally even when a fallback exists', async () => {
    const hostApi = createPluginSurfaceHostApi({
      surfaceContext,
      fallback: async () => ({ shouldNotBeCalled: true }),
    });
    const result = await hostApi.handleRequest(request('getSurfaceContext'));
    expect(result).toMatchObject({ surfaceId: 'surface-1' });
  });

  it('fails closed (no throw) with a safe disabled host api on a malformed surface context (F8)', async () => {
    // Malformed: missing required fields / wrong shape. The factory must NOT throw.
    const malformed = { pluginId: 'acme.preview' } as unknown as PluginUiSurfaceContextV1;
    let hostApi: ReturnType<typeof createPluginSurfaceHostApi> | undefined;
    expect(() => {
      hostApi = createPluginSurfaceHostApi({
        surfaceContext: malformed,
        handlers: { copy: async () => ({ copied: true }) },
        fallback: async () => ({ fellBack: true }),
      });
    }).not.toThrow();
    if (!hostApi) return;

    // Every method fails closed with a diagnostic — including getSurfaceContext and any wired
    // handler/fallback, since the (untrusted) surface context could not be validated.
    const ctxResult = await hostApi.handleRequest(request('getSurfaceContext'));
    expect(ctxResult).toMatchObject({ code: 'invalid_payload' });

    const copyResult = await hostApi.handleRequest(request('copy', { valuePath: '/v' }));
    expect(copyResult).toMatchObject({ code: 'invalid_payload' });

    const fallbackResult = await hostApi.handleRequest(request('openExternal', { urlPath: '/u' }));
    expect(fallbackResult).toMatchObject({ code: 'invalid_payload' });
  });
});
