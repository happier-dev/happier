/**
 * GENERATED FILE CONTRACT (G5-bundled-plugin-translations)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

export const BUNDLED_PLUGIN_TRANSLATIONS = Object.freeze({
  "en": {
    "agentInput.agent.grok": "Grok",
    "agentInput.connectedServiceLabel.claude": "Claude Code",
    "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
    "agentInput.connectedServiceLabel.copilot": "GitHub Copilot",
    "agentInput.connectedServiceLabel.gemini": "Google Gemini",
    "plugins.inspector.description": "Inspect installed plugins, diagnostics, and reload state.",
    "plugins.inspector.settings.showDiagnostics": "Show diagnostics in Plugin Inspector",
    "plugins.inspector.settings.showDiagnostics.description": "Display per-plugin diagnostic details in the inspector surface.",
    "plugins.inspector.title": "Plugin Inspector",
    "profiles.aiBackend.grokSubtitleExperimental": "Grok Build CLI (experimental)",
    "sessionInfo.grokSessionId": "Grok session ID",
    "sessionInfo.grokSessionIdCopied": "Grok session ID copied",
    "settingsVoice.mode.codexRealtime": "Codex Realtime (Experimental)",
    "settingsVoice.mode.codexRealtimeSubtitle": "Speak directly with the active Codex agent session."
  }
} as const);

type KeysOfUnion<T> = T extends T ? keyof T : never;
type BundledPluginTranslationBundle = (typeof BUNDLED_PLUGIN_TRANSLATIONS)[keyof typeof BUNDLED_PLUGIN_TRANSLATIONS];
export type BundledPluginTranslationKey = KeysOfUnion<BundledPluginTranslationBundle> & string;
