/**
 * GENERATED FILE CONTRACT (VOICE-FIRST-PARTY-PROJECTION)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 *
 * Internal first-party build-time projection of inert UI metadata.
 * Executable activation roots are emitted separately by host platform.
 */

import type { BundledVoiceUiEntry } from '@happier-dev/bundled-voice-runtime-contract';

import { BUNDLED_VOICE_UI_ENTRIES as CODEX_BUNDLED_VOICE_UI_ENTRIES } from '@happier-dev/plugins-codex/ui/voice';
import { BUNDLED_VOICE_UI_ENTRIES as ELEVENLABS_BUNDLED_VOICE_UI_ENTRIES } from '@happier-dev/plugins-elevenlabs/ui/voice';
import { BUNDLED_VOICE_UI_ENTRIES as GOOGLE_BUNDLED_VOICE_UI_ENTRIES } from '@happier-dev/plugins-google/ui/voice';
import { BUNDLED_VOICE_UI_ENTRIES as OPENAI_BUNDLED_VOICE_UI_ENTRIES } from '@happier-dev/plugins-openai/ui/voice';
import { BUNDLED_VOICE_UI_ENTRIES as XAI_BUNDLED_VOICE_UI_ENTRIES } from '@happier-dev/plugins-xai/ui/voice';

export const BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES = Object.freeze([
  ...CODEX_BUNDLED_VOICE_UI_ENTRIES,
  ...ELEVENLABS_BUNDLED_VOICE_UI_ENTRIES,
  ...GOOGLE_BUNDLED_VOICE_UI_ENTRIES,
  ...OPENAI_BUNDLED_VOICE_UI_ENTRIES,
  ...XAI_BUNDLED_VOICE_UI_ENTRIES,
]) satisfies readonly BundledVoiceUiEntry[];
