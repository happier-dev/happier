export const DROID_PROVIDER_SETTINGS_PATH = 'droid/settings.json';
export const DROID_PROVIDER_SECRET_ENV = 'HAPPIER_DROID_PROVIDER_API_KEY';
export const DROID_PROVIDER_OWNED_ENV_KEYS = [DROID_PROVIDER_SECRET_ENV, 'FACTORY_API_KEY'] as const;

export function droidProviderModelDisplayName(modelId: string): string {
  return `Happier provider: ${modelId}`;
}

/** Native Factory customModels config shared by Provider and Connected Account routes. */
export function buildDroidModelSettings(input: Readonly<{
  modelId: string;
  baseUrl: string;
  provider: 'openai' | 'generic-chat-completion-api' | 'anthropic';
  headers: Readonly<Record<string, string>>;
  hasCredential: boolean;
  authMode?: 'bearer';
}>): string {
  // Public strings are data. Only the adapter-authored apiKey reference may
  // invoke Factory's native environment interpolation.
  if ([input.modelId, input.baseUrl, ...Object.keys(input.headers), ...Object.values(input.headers)].some(value => value.includes('${'))) {
    throw new Error('Droid Provider data cannot contain native environment substitution');
  }
  if (Object.keys(input.headers).some(name => ['authorization', 'x-api-key'].includes(name.toLowerCase()))) {
    throw new Error('Droid public headers cannot override native authentication');
  }
  return `${JSON.stringify({ customModels: [{
    model: input.modelId,
    displayName: droidProviderModelDisplayName(input.modelId),
    baseUrl: input.baseUrl,
    provider: input.provider,
    ...(input.hasCredential ? { apiKey: `\${${DROID_PROVIDER_SECRET_ENV}}` } : {}),
    ...(input.authMode ? { authMode: input.authMode } : {}),
    ...(Object.keys(input.headers).length ? { extraHeaders: input.headers } : {}),
  }] }, null, 2)}\n`;
}
