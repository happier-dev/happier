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
import { PLUGIN_MANIFEST as CODEX_PLUGIN_MANIFEST } from '@happier-dev/plugins-codex/manifest';
import { activate as CODEX_BUNDLED_VOICE_ACTIVATE } from '@happier-dev/plugins-codex/ui/voice';
import { PLUGIN_MANIFEST as ELEVENLABS_PLUGIN_MANIFEST } from '@happier-dev/plugins-elevenlabs/manifest';
import { activate as ELEVENLABS_BUNDLED_VOICE_ACTIVATE } from '@happier-dev/plugins-elevenlabs/ui/voice';
import { PLUGIN_MANIFEST as OPENAI_PLUGIN_MANIFEST } from '@happier-dev/plugins-openai/manifest';
import { activate as OPENAI_BUNDLED_VOICE_ACTIVATE } from '@happier-dev/plugins-openai/ui/voice';
import { PLUGIN_MANIFEST as XAI_PLUGIN_MANIFEST } from '@happier-dev/plugins-xai/manifest';
import { activate as XAI_BUNDLED_VOICE_ACTIVATE } from '@happier-dev/plugins-xai/ui/voice';

const CODEX_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  CODEX_PLUGIN_MANIFEST,
  CODEX_BUNDLED_VOICE_ACTIVATE,
);
const ELEVENLABS_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  ELEVENLABS_PLUGIN_MANIFEST,
  ELEVENLABS_BUNDLED_VOICE_ACTIVATE,
);
const OPENAI_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  OPENAI_PLUGIN_MANIFEST,
  OPENAI_BUNDLED_VOICE_ACTIVATE,
);
const XAI_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  XAI_PLUGIN_MANIFEST,
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
