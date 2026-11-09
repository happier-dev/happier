import { buildKimiSelectedModelConfig } from './models.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Pure representation: the host alone creates the private home and applies environment. */
export async function materializeKimiConfig(input: Readonly<{
  modelResponse: unknown; apiBase: string; accessToken: string; selectedConfig?: string | null;
  existingConfig?: Uint8Array;
}>): Promise<Uint8Array> {
  const { parse, stringify } = await import('smol-toml');
  const existing = input.existingConfig ? parse(new TextDecoder().decode(input.existingConfig)) : {};
  const selected = input.selectedConfig ? record(JSON.parse(input.selectedConfig)) : {};
  const aliases = record(selected.models);
  const defaultAlias = typeof selected.default_model === 'string' ? record(aliases[selected.default_model]) : {};
  const defaultModel = typeof defaultAlias.model === 'string' ? `kimi-code/${defaultAlias.model}` : undefined;
  const catalog = buildKimiSelectedModelConfig(input.modelResponse, input.apiBase, defaultModel);
  const services = record({ ...record(existing.services), ...record(selected.services) });
  for (const name of ['moonshot_search', 'moonshot_fetch']) {
    if (!Object.hasOwn(services, name)) continue;
    const { oauth: _oauth, api_key: _apiKey, api_key_env: _env, ...service } = record(services[name]);
    services[name] = { ...service, base_url: `${input.apiBase}/${name === 'moonshot_search' ? 'search' : 'fetch'}`, api_key: input.accessToken };
  }
  const config = { ...existing, ...selected, ...catalog, services };
  return new TextEncoder().encode(stringify(config));
}
