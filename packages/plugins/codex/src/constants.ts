/**
 * Local contribution id of the Codex Realtime Voice provider.
 *
 * It is the `voiceProviders` manifest key and the id the client Voice artifact
 * registers, so the literal has exactly one owner. Keeping it in a leaf module
 * is also what stops `ui/voice` — a browser/React Native artifact reached from
 * `apps/ui` — from importing the daemon manifest graph just to read a string.
 */
export const CODEX_VOICE_PROVIDER_CONTRIBUTION_ID = 'realtime-codex';

/** Canonical qualified key of the Codex OpenAI Connected Account service. */
export const CODEX_OPENAI_CONNECTED_ACCOUNT_SERVICE_KEY =
  'happier.agent.codex/openai-codex';
