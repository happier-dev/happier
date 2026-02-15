/**
 * Resolves the configured ElevenLabs agent ID, if any.
 * Returns `undefined` when no usable agent ID is configured.
 */
export function resolveElevenLabsAgentId(env: NodeJS.ProcessEnv): string | undefined {
  const isProduction = env.NODE_ENV === 'production';
  const generic = typeof env.ELEVENLABS_AGENT_ID === 'string' ? env.ELEVENLABS_AGENT_ID.trim() : '';
  const prod = typeof env.ELEVENLABS_AGENT_ID_PROD === 'string' ? env.ELEVENLABS_AGENT_ID_PROD.trim() : '';

  const resolved = isProduction ? (prod || generic) : (generic || prod);
  return resolved || undefined;
}

export function resolveElevenLabsApiBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = typeof env.ELEVENLABS_API_BASE_URL === 'string' ? env.ELEVENLABS_API_BASE_URL.trim() : '';
  const base = raw || 'https://api.elevenlabs.io';
  return base.replace(/\/+$/, '');
}
