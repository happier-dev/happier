import { describe, expect, it } from 'vitest';

import { selectGrokAuthentication } from './auth.js';
import { GROK_PREFLIGHT_SESSION_CONTROLS } from '../preflight/models.js';

describe('Grok ACP authentication', () => {
  it('honors an explicit subscription over an ambient key and an initialized API-key default', () => {
    expect(selectGrokAuthentication({ advertisedMethodIds: ['cached_token', 'xai.api_key'],
      initializeMetadata: { defaultAuthMethodId: 'xai.api_key' } }, { XAI_API_KEY: 'fake-ambient-key', GROK_CONNECTED_ACCOUNT_MODE: 'subscription' }))
      .toEqual({ methodId: 'cached_token', metadata: { headless: true } });
  });

  it('requires the explicitly selected method and never changes billing mode when it is unavailable', () => {
    expect(selectGrokAuthentication({ advertisedMethodIds: ['cached_token', 'xai.api_key'], initializeMetadata: null }, { GROK_CONNECTED_ACCOUNT_MODE: 'api-key' }))
      .toEqual({ methodId: 'xai.api_key', metadata: { headless: true } });
    expect(() => selectGrokAuthentication({ advertisedMethodIds: ['cached_token'], initializeMetadata: null }, { GROK_CONNECTED_ACCOUNT_MODE: 'api-key' })).toThrow();
    expect(() => selectGrokAuthentication({ advertisedMethodIds: ['xai.api_key'], initializeMetadata: null }, { GROK_CONNECTED_ACCOUNT_MODE: 'subscription' })).toThrow();
  });

  it('shares advertised headless auth selection with preflight through environment presence', () => {
    const catalogs = GROK_PREFLIGHT_SESSION_CONTROLS as {
      catalogs?: { selectAuthentication?: (input: unknown) => unknown };
    };
    expect(catalogs.catalogs?.selectAuthentication?.({
      initializeResult: { authMethods: [{ id: 'xai.api_key' }, { id: 'cached_token' }], _meta: null },
      probe: { accountSettings: null, environment: { XAI_API_KEY: true }, nonblankEnvironment: { XAI_API_KEY: true } },
    })).toEqual({ methodId: 'xai.api_key', metadata: { headless: true } });
    expect(catalogs.catalogs?.selectAuthentication?.({
      initializeResult: { authMethods: [{ id: 'xai.api_key' }, { id: 'cached_token' }], _meta: null },
      probe: { accountSettings: null, environment: { XAI_API_KEY: true }, nonblankEnvironment: { XAI_API_KEY: false } },
    })).toEqual({ methodId: 'cached_token', metadata: { headless: true } });
    expect(catalogs.catalogs?.selectAuthentication?.({
      initializeResult: { authMethods: [{ id: 'grok.com' }], _meta: { defaultAuthMethodId: 'grok.com' } },
      probe: { accountSettings: null, environment: {} },
    })).toEqual({ methodId: 'grok.com', metadata: { headless: true } });
  });

  it('honors the native pinned API-key default during selected-account preflight without changing unbound behavior', () => {
    const select = GROK_PREFLIGHT_SESSION_CONTROLS.catalogs.selectAuthentication;
    const initializeResult = { authMethods: [{ id: 'xai.api_key' }, { id: 'cached_token' }], _meta: { defaultAuthMethodId: 'xai.api_key' } };
    expect(select({ initializeResult, probe: { accountSettings: null, environment: {},
      nonblankEnvironment: { GROK_CONNECTED_ACCOUNT_MODE: true } } }))
      .toEqual({ methodId: 'xai.api_key', metadata: { headless: true } });
    expect(select({ initializeResult, probe: { accountSettings: null, environment: {} } }))
      .toEqual({ methodId: 'cached_token', metadata: { headless: true } });
  });

  it('keeps selected-subscription preflight exact when native initialization advertises a conflicting paid default', () => {
    const select = GROK_PREFLIGHT_SESSION_CONTROLS.catalogs.selectAuthentication;
    const initializeResult = { authMethods: [{ id: 'xai.api_key' }, { id: 'cached_token' }], _meta: { defaultAuthMethodId: 'xai.api_key' } };
    expect(select({ initializeResult, probe: { accountSettings: null, environment: {},
      nonblankEnvironment: { GROK_CONNECTED_ACCOUNT_MODE: true, GROK_OAUTH2_ISSUER: true, XAI_API_KEY: true } } }))
      .toEqual({ methodId: 'cached_token', metadata: { headless: true } });
    expect(() => select({ initializeResult: { authMethods: [{ id: 'xai.api_key' }] },
      probe: { accountSettings: null, environment: {}, nonblankEnvironment: { GROK_CONNECTED_ACCOUNT_MODE: true, GROK_OAUTH2_ISSUER: true } } })).toThrow();
  });

  it('prefers advertised xAI API-key auth when the declared environment value is nonblank', () => {
    expect(selectGrokAuthentication({
      advertisedMethodIds: ['cached_token', 'xai.api_key'], initializeMetadata: null,
    }, { XAI_API_KEY: ' key ' })).toEqual({ methodId: 'xai.api_key', metadata: { headless: true } });
  });

  it('uses an advertised initialized cached default, then deterministic cached fallbacks', () => {
    expect(selectGrokAuthentication({
      advertisedMethodIds: ['grok.com'], initializeMetadata: { defaultAuthMethodId: 'grok.com' },
    }, {})).toEqual({ methodId: 'grok.com', metadata: { headless: true } });
    expect(selectGrokAuthentication({
      advertisedMethodIds: ['cached_token'], initializeMetadata: null,
    }, {})).toEqual({ methodId: 'cached_token', metadata: { headless: true } });
    expect(() => selectGrokAuthentication({
      advertisedMethodIds: ['grok.com'], initializeMetadata: null,
    }, {})).toThrow('Run `grok login`');
  });
});
