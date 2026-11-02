/**
 * GENERATED FILE CONTRACT (VOICE-FIRST-PARTY-RUNTIME-PROJECTION)
 *
 * This file is emitted by:
 * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`
 *
 * Executable first-party Voice activation roots for the declared host platforms.
 * Contributions that do not declare this host platform are absent.
 */

import { createBundledConversationRuntimeEntries, type BundledConversationRuntimeEntry } from './bundledConversationRuntimeEntries';
const CODEX_BUNDLED_VOICE_ACTIVATE = async () => (await import('@happier-dev/plugins-codex/happier-plugin-ui/voice-runtime-web')).activate;
const ELEVENLABS_BUNDLED_VOICE_ACTIVATE = async () => (await import('@happier-dev/plugins-elevenlabs/happier-plugin-ui/voice-runtime')).activate;
const OPENAI_BUNDLED_VOICE_ACTIVATE = async () => (await import('@happier-dev/plugins-openai/happier-plugin-ui/voice-runtime-web')).activate;
const XAI_BUNDLED_VOICE_ACTIVATE = async () => (await import('@happier-dev/plugins-xai/happier-plugin-ui/voice-runtime-web')).activate;
import { CODEX_BUNDLED_VOICE_MANIFEST, ELEVENLABS_BUNDLED_VOICE_MANIFEST, OPENAI_BUNDLED_VOICE_MANIFEST, XAI_BUNDLED_VOICE_MANIFEST } from './generatedBundledVoiceEntries';
const CODEX_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  CODEX_BUNDLED_VOICE_MANIFEST,
  CODEX_BUNDLED_VOICE_ACTIVATE,
);
const ELEVENLABS_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  ELEVENLABS_BUNDLED_VOICE_MANIFEST,
  ELEVENLABS_BUNDLED_VOICE_ACTIVATE,
);
const OPENAI_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  OPENAI_BUNDLED_VOICE_MANIFEST,
  OPENAI_BUNDLED_VOICE_ACTIVATE,
);
const XAI_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  XAI_BUNDLED_VOICE_MANIFEST,
  XAI_BUNDLED_VOICE_ACTIVATE,
);

export const BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES = Object.freeze([
  ...CODEX_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,
  ...ELEVENLABS_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,
  ...OPENAI_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,
  ...XAI_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,
]) satisfies readonly BundledConversationRuntimeEntry[];

/**
 * Exact generated first-party entry identities admitted to the hosted
 * conversation service. This is intentionally separate from provider ids and
 * manifest metadata so copied or colliding external entries fail closed.
 */
export const BUNDLED_FIRST_PARTY_HOSTED_CONVERSATION_RUNTIME_ENTRIES = Object.freeze([
  ...ELEVENLABS_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,
]) satisfies readonly BundledConversationRuntimeEntry[];
