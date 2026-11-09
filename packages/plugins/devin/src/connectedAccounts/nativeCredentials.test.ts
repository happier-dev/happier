import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { DEVIN_NATIVE_GENERATION, parseDevinNativeCredentials, serializeDevinSelectedCredentials } from './nativeCredentials.js';

// Sanitized CredentialsFile shape accepted by the published CLI 3000.12.32
// local TOML loader under a temporary HOME; no native login or live token.
const nativeSessionFixture = `windsurf_api_key = "devin-session-token$eyJ.fake.session"
api_server_url = "https://server.codeium.com"
devin_webapp_host = "app.devin.ai"
devin_api_url = "https://api.devin.ai"
dangerously_skip_plugin_authentication = false
`;
describe('Devin native credential generation', () => {
  it.each([
    ['session', nativeSessionFixture],
    ['enterprise', 'windsurf_api_key = "fake-seat-key"\napi_server_url = "https://enterprise.example.test"\n'],
  ] as const)('round trips the complete supported %s representation without a refresh credential', (mode, raw) => {
    const native = parseDevinNativeCredentials(parse(raw));
    expect(native).toMatchObject({ generation: DEVIN_NATIVE_GENERATION, mode });
    if (!native) throw new Error('Expected supported native credentials');
    expect(parse(new TextDecoder().decode(serializeDevinSelectedCredentials(native)))).toEqual(parse(raw));
  });
  it('uses the observed default server only when its optional native field is absent', () => {
    expect(parseDevinNativeCredentials({ windsurf_api_key: 'fake-seat' })).toMatchObject({ mode: 'enterprise', apiServerUrl: 'https://server.codeium.com' });
  });
  it.each([
    { session_token: 'fake-other-schema' },
    { windsurf_api_key: 'fake-seat', schema_version: 999 },
    { windsurf_api_key: 'fake-seat', api_server_url: 42 },
    { windsurf_api_key: 'fake-seat', devin_api_url: 'not-a-url' },
    { windsurf_api_key: 'fake-seat', devin_webapp_host: 'https://app.example.test' },
    { windsurf_api_key: 'fake-seat', dangerously_skip_plugin_authentication: 'false' },
  ])('stops unsupported generations before staging or losing auth metadata', value => {
    expect(parseDevinNativeCredentials(value)).toBeNull();
  });
});
