import { describe, expect, it } from 'vitest';
import { buildMuseNativeAuth, parseMuseNativeAuth } from './nativeAuth.js';

const meta = {
  access_token: 'synthetic-account-token', api_key: 'synthetic-inference-key',
  api_base_url: 'https://api.meta.ai/v1', mechanism: 'oauth', obtained_via: 'device_code',
  subs_active: true, user_email: 'person@example.test', user_full_name: null,
};

describe('Muse native credential boundary (1.4.14)', () => {
  it('preserves complete account-login credentials without inventing expiry', () => {
    const parsed = parseMuseNativeAuth({ schema_version: 1, providers: { meta } });
    expect(parsed).toEqual({ status: 'supported', auth: { schema_version: 1, providers: { meta } }, mode: 'accountLogin' });
    if (parsed.status !== 'supported') throw new Error('Expected supported native auth');
    expect(buildMuseNativeAuth(parsed.auth.providers.meta)).toEqual(parsed.auth);
    expect(parsed.auth.providers.meta).not.toHaveProperty('expires_at');
  });

  it('distinguishes parser refusal from accepted native key-mode fallback', () => {
    expect(parseMuseNativeAuth({ providers: { meta } })).toMatchObject({ status: 'invalid' });
    expect(parseMuseNativeAuth({ schema_version: 999, providers: { meta } })).toMatchObject({ status: 'unsupported' });
    const { obtained_via: _source, ...withoutSource } = meta;
    expect(parseMuseNativeAuth({ schema_version: 1, providers: { meta: withoutSource } })).toMatchObject({ status: 'invalid' });
    const { mechanism: _mechanism, ...withoutMechanism } = meta;
    expect(parseMuseNativeAuth({ schema_version: 1, providers: { meta: withoutMechanism } })).toMatchObject({ status: 'supported', mode: 'apiKey' });
    expect(parseMuseNativeAuth({ schema_version: 1, providers: { meta: { ...meta, mechanism: 'future' } } })).toMatchObject({ status: 'supported', mode: 'apiKey' });
    expect(parseMuseNativeAuth({ schema_version: 1, providers: { meta: { ...meta, obtained_via: 'native-value' } } })).toMatchObject({ status: 'supported', mode: 'accountLogin' });
  });
});
