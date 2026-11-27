export const BUNDLED_VOICE_RUNTIME_PLATFORMS: readonly ['web', 'ios', 'android'];
export function resolveBundledVoiceRuntimeProjectionOutPath(rootDir: string, platform: string): string;
export function resolveGeneratorHostProjectionOutPaths(rootDir: string): Record<
  'cliOutPath' | 'cliManifestOutPath' | 'uiOutPath' | 'agentPresentationOutPath'
  | 'uiTranslationKeysOutPath' | 'uiVoiceEntriesOutPath' | 'protocolVoiceSelectionOptionsOutPath'
  | 'uiBehaviorOverridesOutPath' | 'sessionAgentBehaviorsOutPath' | 'visibleMessageResolversOutPath'
  | 'retiredAgentSettingsOutPath', string>;
export function resolveBundledPluginTranslationLocaleDirectory(rootDir: string): string;
export function resolveBundledPluginUiProjectionInputPaths(rootDir: string): string[];
