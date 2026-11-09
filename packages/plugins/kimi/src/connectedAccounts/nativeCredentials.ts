import { z } from 'zod';

const nativeToken = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1),
  expires_at: z.number().finite().nonnegative(), expires_in: z.number().finite().nonnegative().optional(),
  scope: z.string().optional(), token_type: z.string().optional(),
});
export function parseKimiNodeCredentials(value: unknown) {
  const token = nativeToken.parse(value);
  return { accessToken: token.access_token, refreshToken: token.refresh_token,
    expiresAtMs: token.expires_at * 1000, scope: token.scope, tokenType: token.token_type, expiresIn: token.expires_in };
}
function failure(code: string): never {
  throw Object.assign(new Error('Kimi Node configuration is unavailable or unsupported'), { code });
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Input is a parsed Node config.toml, never the old Python config or a profile inventory. */
export function resolveKimiNodeCredentialReference(value: unknown) {
  const config = record(value);
  const models = record(config.models);
  const model = typeof config.default_model === 'string' ? config.default_model : '';
  if (!model || !Object.hasOwn(models, model)) return failure('kimi_default_model_unavailable');
  const modelConfig = record(models[model]);
  const provider = typeof modelConfig.provider === 'string' ? modelConfig.provider : '';
  const selected = record(record(config.providers)[provider]);
  if (!provider || selected.type !== 'kimi' || typeof selected.base_url !== 'string') return failure('kimi_native_schema_unsupported');
  const oauth = record(selected.oauth);
  const key = typeof oauth.key === 'string' && oauth.key.startsWith('oauth/') ? oauth.key.slice('oauth/'.length) : oauth.key;
  if (selected.api_key || selected.api_key_env || oauth.storage !== 'file' || typeof oauth.key !== 'string'
    || typeof key !== 'string' || !key || key.startsWith('.') || /[/\\]/u.test(key)) return failure('kimi_native_credential_reference_unsupported');
  return { provider, model, baseUrl: selected.base_url, credentialFile: `credentials/${key}.json`,
    ...(typeof oauth.oauth_host === 'string' && oauth.oauth_host ? { oauthHost: oauth.oauth_host } : {}) };
}

/** Return the complete config data for the existing home writer's TOML serializer.
 * Credential alternatives are removed; native models/preferences/MCP remain selected data. */
export function serializeKimiSelectedConfig(value: unknown): Record<string, unknown> & { providers: Record<string, unknown> } {
  const config = record(value);
  const reference = resolveKimiNodeCredentialReference(config);
  const source = record(record(config.providers)[reference.provider]);
  const { oauth: _oauth, api_key: _key, api_key_env: _env, env: _overrides, ...provider } = source;
  const models = Object.fromEntries(Object.entries(record(config.models)).filter(([, model]) => record(model).provider === reference.provider));
  const services = { ...record(config.services) };
  for (const name of ['moonshot_search', 'moonshot_fetch']) {
    if (!Object.hasOwn(services, name)) continue;
    const { oauth: _oauth, api_key: _key, api_key_env: _env, ...service } = record(services[name]);
    services[name] = service;
  }
  return { ...config, models, ...(config.services ? { services } : {}), providers: { [reference.provider]: { ...provider, api_key_env: 'HAPPIER_KIMI_ACCESS_TOKEN' } } };
}
