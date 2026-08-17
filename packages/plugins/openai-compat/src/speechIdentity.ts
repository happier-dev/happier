import { PLUGIN_MANIFEST } from './manifest.js';

function readCredentialEnvironmentKey(contributionId: 'stt' | 'tts'): string {
  const contribution = PLUGIN_MANIFEST.contributes.voiceProviders.find(
    (candidate) => candidate.id === contributionId,
  );
  const environmentKey = contribution?.credentials.sources[0]?.rawGrants[0]?.request.keys[0];
  if (typeof environmentKey !== 'string' || environmentKey.length === 0) {
    throw new Error(`Missing OpenAI-compatible ${contributionId} credential environment key`);
  }
  return environmentKey;
}

export const OPENAI_COMPAT_STT_CREDENTIAL_ENVIRONMENT_KEY = readCredentialEnvironmentKey('stt');
export const OPENAI_COMPAT_TTS_CREDENTIAL_ENVIRONMENT_KEY = readCredentialEnvironmentKey('tts');
