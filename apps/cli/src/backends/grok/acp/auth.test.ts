import { describe, expect, it } from 'vitest';

import { resolveAcpAuthenticationSelection } from '@/agent/acp/AcpAuthentication';

import {
  GrokAcpAuthenticationUnavailableError,
  createGrokAcpAuthentication,
} from './auth';

function resolve(params: Readonly<{
  hasXaiApiKey: boolean;
  advertised: readonly string[];
  defaultAuthMethodId?: unknown;
}>) {
  return resolveAcpAuthenticationSelection({
    authentication: createGrokAcpAuthentication({ hasXaiApiKey: params.hasXaiApiKey }),
    advertisedMethodIds: new Set(params.advertised),
    initializeMeta: params.defaultAuthMethodId === undefined
      ? null
      : { defaultAuthMethodId: params.defaultAuthMethodId },
  });
}

describe('Grok ACP authentication', () => {
  it('prioritizes an advertised API-key method when a non-empty key is present', () => {
    expect(resolve({
      hasXaiApiKey: true,
      advertised: ['cached_token', 'grok.com', 'xai.api_key'],
      defaultAuthMethodId: 'grok.com',
    })).toEqual({ methodId: 'xai.api_key', meta: { headless: true } });
  });

  it('does not select API-key auth when the key is absent or the method is unadvertised', () => {
    expect(resolve({
      hasXaiApiKey: false,
      advertised: ['xai.api_key', 'cached_token'],
    })).toEqual({ methodId: 'cached_token', meta: { headless: true } });
    expect(resolve({
      hasXaiApiKey: true,
      advertised: ['cached_token'],
    })).toEqual({ methodId: 'cached_token', meta: { headless: true } });
  });

  it.each(['grok.com', 'cached_token'] as const)(
    'selects an advertised initialized %s default',
    (methodId) => {
      expect(resolve({
        hasXaiApiKey: false,
        advertised: [methodId],
        defaultAuthMethodId: methodId,
      })).toEqual({ methodId, meta: { headless: true } });
    },
  );

  it('retains advertised cached_token compatibility when initialize has no default', () => {
    expect(resolve({
      hasXaiApiKey: false,
      advertised: ['cached_token'],
      defaultAuthMethodId: null,
    })).toEqual({ methodId: 'cached_token', meta: { headless: true } });
  });

  it('never auto-selects a logged-out non-default grok.com method', () => {
    const authentication = createGrokAcpAuthentication({ hasXaiApiKey: false });
    expect(() => authentication.kind === 'resolve-after-initialize'
      ? authentication.resolve({
          advertisedMethodIds: new Set(['grok.com']),
          initializeMeta: { defaultAuthMethodId: null },
        })
      : null).toThrow(GrokAcpAuthenticationUnavailableError);
  });

  it.each([
    { advertised: ['grok.com'], defaultAuthMethodId: 'cached_token' },
    { advertised: ['grok.com'], defaultAuthMethodId: ' xai.api_key ' },
    { advertised: ['xai.api_key'], defaultAuthMethodId: 'grok.com' },
    { advertised: [], defaultAuthMethodId: 'grok.com' },
    { advertised: ['grok.com'], defaultAuthMethodId: { id: 'grok.com' } },
  ])('fails closed for an unusable advertised/default combination: %o', (candidate) => {
    const authentication = createGrokAcpAuthentication({ hasXaiApiKey: false });
    expect(() => authentication.kind === 'resolve-after-initialize'
      ? authentication.resolve({
          advertisedMethodIds: new Set(candidate.advertised),
          initializeMeta: { defaultAuthMethodId: candidate.defaultAuthMethodId },
        })
      : null).toThrow(GrokAcpAuthenticationUnavailableError);
  });

  it('exposes fixed non-secret login recovery guidance through the provider error', () => {
    const error = new GrokAcpAuthenticationUnavailableError();
    expect(error).toMatchObject({
      code: 'GROK_ACP_AUTHENTICATION_UNAVAILABLE',
      safePublicMessage: expect.stringContaining('grok login'),
    });
    expect(JSON.stringify(error)).not.toContain('XAI_API_KEY');
  });

  it('preserves only the explicit safe provider recovery contract through shared resolution', () => {
    expect(() => resolve({
      hasXaiApiKey: false,
      advertised: ['grok.com'],
      defaultAuthMethodId: null,
    })).toThrow(expect.objectContaining({
      code: 'GROK_ACP_AUTHENTICATION_UNAVAILABLE',
      safePublicMessage: expect.stringContaining('grok login --device-auth'),
    }));
  });
});
