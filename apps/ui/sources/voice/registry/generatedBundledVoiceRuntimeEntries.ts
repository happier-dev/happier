/**
 * GENERATED FILE CONTRACT (VOICE-FIRST-PARTY-RUNTIME-PROJECTION)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 *
 * Executable first-party Voice activation roots for web.
 * Contributions that do not declare this host platform are absent.
 */

import { createBundledConversationRuntimeEntries, type BundledConversationRuntimeEntry } from './bundledConversationRuntimeEntries';
import { BUNDLED_VOICE_UI_ENTRIES as CODEX_BUNDLED_VOICE_UI_ENTRIES, activate as CODEX_BUNDLED_VOICE_ACTIVATE } from '@happier-dev/plugins-codex/ui/voice';
import { BUNDLED_VOICE_UI_ENTRIES as ELEVENLABS_BUNDLED_VOICE_UI_ENTRIES, activate as ELEVENLABS_BUNDLED_VOICE_ACTIVATE } from '@happier-dev/plugins-elevenlabs/ui/voice';
import { BUNDLED_VOICE_UI_ENTRIES as OPENAI_BUNDLED_VOICE_UI_ENTRIES, activate as OPENAI_BUNDLED_VOICE_ACTIVATE } from '@happier-dev/plugins-openai/ui/voice';
import { BUNDLED_VOICE_UI_ENTRIES as XAI_BUNDLED_VOICE_UI_ENTRIES, activate as XAI_BUNDLED_VOICE_ACTIVATE } from '@happier-dev/plugins-xai/ui/voice';

const CODEX_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  CODEX_BUNDLED_VOICE_UI_ENTRIES,
  CODEX_BUNDLED_VOICE_ACTIVATE,
);
const ELEVENLABS_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  ELEVENLABS_BUNDLED_VOICE_UI_ENTRIES,
  ELEVENLABS_BUNDLED_VOICE_ACTIVATE,
);
const OPENAI_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  OPENAI_BUNDLED_VOICE_UI_ENTRIES,
  OPENAI_BUNDLED_VOICE_ACTIVATE,
);
const XAI_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  XAI_BUNDLED_VOICE_UI_ENTRIES,
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
