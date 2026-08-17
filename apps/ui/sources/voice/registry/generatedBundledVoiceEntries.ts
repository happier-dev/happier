/**
 * GENERATED FILE CONTRACT (VOICE-FIRST-PARTY-PROJECTION)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 *
 * Normalized first-party manifest projection plus qualified presentation.
 * Executable activation roots are emitted separately by host platform.
 */

import { projectBundledVoiceManifestContributions } from './bundledVoiceManifestProjection';
import type { BundledVoiceManifestContribution } from './bundledVoiceManifestProjection';
import type { VoiceProviderPresentation } from './voiceProviderPresentation';

import { PLUGIN_MANIFEST as CODEX_PLUGIN_MANIFEST } from '@happier-dev/plugins-codex/manifest';
import { VOICE_PROVIDER_PRESENTATIONS as CODEX_VOICE_PROVIDER_PRESENTATIONS } from '@happier-dev/plugins-codex/ui/voice';
import { PLUGIN_MANIFEST as ELEVENLABS_PLUGIN_MANIFEST } from '@happier-dev/plugins-elevenlabs/manifest';
import { VOICE_PROVIDER_PRESENTATIONS as ELEVENLABS_VOICE_PROVIDER_PRESENTATIONS } from '@happier-dev/plugins-elevenlabs/ui/voice';
import { PLUGIN_MANIFEST as GOOGLE_PLUGIN_MANIFEST } from '@happier-dev/plugins-google/manifest';
import { VOICE_PROVIDER_PRESENTATIONS as GOOGLE_VOICE_PROVIDER_PRESENTATIONS } from '@happier-dev/plugins-google/ui/voice';
import { PLUGIN_MANIFEST as OPENAI_PLUGIN_MANIFEST } from '@happier-dev/plugins-openai/manifest';
import { VOICE_PROVIDER_PRESENTATIONS as OPENAI_VOICE_PROVIDER_PRESENTATIONS } from '@happier-dev/plugins-openai/ui/voice';
import { PLUGIN_MANIFEST as OPENAI_COMPAT_PLUGIN_MANIFEST } from '@happier-dev/plugins-openai-compat/manifest';
import { VOICE_PROVIDER_PRESENTATIONS as OPENAI_COMPAT_VOICE_PROVIDER_PRESENTATIONS } from '@happier-dev/plugins-openai-compat/ui/voice';
import { PLUGIN_MANIFEST as XAI_PLUGIN_MANIFEST } from '@happier-dev/plugins-xai/manifest';
import { VOICE_PROVIDER_PRESENTATIONS as XAI_VOICE_PROVIDER_PRESENTATIONS } from '@happier-dev/plugins-xai/ui/voice';

export const BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS = Object.freeze([
  ...projectBundledVoiceManifestContributions(CODEX_PLUGIN_MANIFEST),
  ...projectBundledVoiceManifestContributions(ELEVENLABS_PLUGIN_MANIFEST),
  ...projectBundledVoiceManifestContributions(GOOGLE_PLUGIN_MANIFEST),
  ...projectBundledVoiceManifestContributions(OPENAI_PLUGIN_MANIFEST),
  ...projectBundledVoiceManifestContributions(OPENAI_COMPAT_PLUGIN_MANIFEST),
  ...projectBundledVoiceManifestContributions(XAI_PLUGIN_MANIFEST),
]) satisfies readonly BundledVoiceManifestContribution[];

export const BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS = Object.freeze([
  ...CODEX_VOICE_PROVIDER_PRESENTATIONS,
  ...ELEVENLABS_VOICE_PROVIDER_PRESENTATIONS,
  ...GOOGLE_VOICE_PROVIDER_PRESENTATIONS,
  ...OPENAI_VOICE_PROVIDER_PRESENTATIONS,
  ...OPENAI_COMPAT_VOICE_PROVIDER_PRESENTATIONS,
  ...XAI_VOICE_PROVIDER_PRESENTATIONS,
]) satisfies readonly VoiceProviderPresentation[];
