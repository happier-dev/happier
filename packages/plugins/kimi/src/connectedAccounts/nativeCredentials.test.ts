import { describe, expect, it } from 'vitest';
import { parseKimiNodeCredentials, resolveKimiNodeCredentialReference, serializeKimiSelectedConfig } from './nativeCredentials.js';

describe('Kimi Node selected credentials', () => {
  const config = {
    default_model: 'custom/k3',
    providers: { personal: { type: 'kimi', base_url: 'https://api.kimi.ai/coding/v1', oauth: { storage: 'file', key: 'selected-b' } }, unrelated: { api_key: 'fake-a' } },
    models: { 'custom/k3': { provider: 'personal', model: 'k3', max_context_size: 1048576 } },
    thinking: { effort: 'high' },
  };
  it('imports exactly the selected Node reference and preserves refresh provenance and seconds', () => {
    expect(resolveKimiNodeCredentialReference(config)).toEqual({ provider: 'personal', model: 'custom/k3', baseUrl: 'https://api.kimi.ai/coding/v1', credentialFile: 'credentials/selected-b.json' });
    expect(parseKimiNodeCredentials({ access_token: 'fake-b', refresh_token: 'fake-root', expires_at: 1800000000, expires_in: 3600, scope: 'coding', token_type: 'Bearer' })).toMatchObject({ accessToken: 'fake-b', refreshToken: 'fake-root', expiresAtMs: 1800000000000 });
  });
  it('maps the published oauth/ storage key to the exact Node credential filename', () => {
    expect(resolveKimiNodeCredentialReference({ ...config, providers: { personal: {
      ...config.providers.personal, oauth: { storage: 'file', key: 'oauth/selected-b', oauth_host: 'https://auth.kimi.ai' },
    } } })).toMatchObject({ credentialFile: 'credentials/selected-b.json', oauthHost: 'https://auth.kimi.ai' });
  });
  it('replaces all credential alternatives without changing models or tool configuration', () => {
    const selected = serializeKimiSelectedConfig(config);
    expect(selected.providers).toEqual({ personal: { type: 'kimi', base_url: 'https://api.kimi.ai/coding/v1', api_key_env: 'HAPPIER_KIMI_ACCESS_TOKEN' } });
    expect(selected.models).toEqual(config.models);
    expect(selected.thinking).toEqual(config.thinking);
    expect(JSON.stringify(selected)).not.toContain('fake-');
    expect(JSON.stringify(config)).toContain('fake-a');
  });
  it('reports a missing default model instead of choosing another account model', () => {
    expect(() => resolveKimiNodeCredentialReference({ ...config, default_model: 'absent' })).toThrowError(expect.objectContaining({ code: 'kimi_default_model_unavailable' }));
  });
  it.each(['../other', '..\\other', '.hidden', ''])('rejects a non-file Node credential reference %s', key => {
    expect(() => resolveKimiNodeCredentialReference({ ...config, providers: { personal: { ...config.providers.personal, oauth: { storage: 'file', key } } } })).toThrow();
  });
  it('rejects old Python and conflicting credential declarations explicitly', () => {
    expect(() => resolveKimiNodeCredentialReference({ default_model: 'legacy', providers: {} })).toThrow();
    expect(() => resolveKimiNodeCredentialReference({ ...config, providers: { personal: { ...config.providers.personal, api_key: 'fake-conflict' } } })).toThrow();
    expect(() => parseKimiNodeCredentials({ access_token: 'fake', expires_at: 'tomorrow' })).toThrow();
  });
});
