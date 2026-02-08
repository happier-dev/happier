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
