/**
 * Local contribution id of the xAI Grok Voice provider.
 *
 * It is the `voiceProviders` manifest key and the id the client Voice artifacts
 * (web and native) register, so the literal has exactly one owner. Keeping it in
 * a leaf module is also what stops `ui/voice` — a browser/React Native artifact
 * reached from `apps/ui` — from importing the daemon manifest graph just to read
 * a string.
 */
export const XAI_VOICE_PROVIDER_CONTRIBUTION_ID = 'realtime-grok';
