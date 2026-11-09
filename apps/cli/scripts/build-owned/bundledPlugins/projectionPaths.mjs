import { dirname, join, relative, resolve } from 'node:path';

export const BUNDLED_VOICE_RUNTIME_PLATFORMS = Object.freeze(['web', 'ios', 'android']);

export function resolveBundledVoiceRuntimeProjectionOutPath(rootDir, platform) {
  return resolve(rootDir, 'apps/ui/sources/voice/registry',
    `generatedBundledVoiceRuntimeEntries${platform === 'web' ? '' : `.${platform}`}.ts`);
}

export function resolveGeneratorHostProjectionOutPaths(rootDir) {
  return {
    cliOutPath: resolve(rootDir, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    cliManifestOutPath: resolve(rootDir, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'),
    uiOutPath: resolve(rootDir, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    agentLogoSvgOutPath: resolve(rootDir, 'apps/ui/sources/agents/registry/generatedAgentLogoSvgXml.ts'),
    agentPresentationOutPath: resolve(rootDir, 'packages/agents/src/generated/bundledAgentPresentation.ts'),
    uiTranslationsOutPath: resolve(rootDir, 'apps/ui/sources/text/bundledPluginTranslations.generated.ts'),
    uiTranslationKeysOutPath: resolve(rootDir, 'apps/ui/sources/text/bundledPluginTranslationKeys.generated.ts'),
    uiVoiceEntriesOutPath: resolve(rootDir, 'apps/ui/sources/voice/registry/generatedBundledVoiceEntries.ts'),
    protocolVoiceSelectionOptionsOutPath: resolve(rootDir, 'packages/protocol/src/voice/settings/generatedBundledVoiceSelectionOptions.ts'),
    uiBehaviorOverridesOutPath: resolve(rootDir, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides.ts'),
    sessionAgentBehaviorsOutPath: resolve(rootDir, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.sessionAgentBehaviors.ts'),
    visibleMessageResolversOutPath: resolve(rootDir, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.visibleMessageResolvers.ts'),
    retiredAgentSettingsOutPath: resolve(rootDir, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.agentSettings.ts'),
  };
}

export function resolveBundledPluginTranslationLocaleDirectory(rootDir) {
  return join(dirname(resolveGeneratorHostProjectionOutPaths(rootDir).uiTranslationsOutPath), 'bundledPluginTranslations');
}

/** Generated host UI outputs are checker inputs, not the app's source graph. */
export function resolveBundledPluginUiProjectionInputPaths(rootDir) {
  const uiRoot = resolve(rootDir, 'apps/ui');
  return [
    ...Object.values(resolveGeneratorHostProjectionOutPaths(rootDir))
      .filter(path => relative(uiRoot, path).split(/[\\/]/)[0] === 'sources'),
    ...BUNDLED_VOICE_RUNTIME_PLATFORMS.map(platform => resolveBundledVoiceRuntimeProjectionOutPath(rootDir, platform)),
    resolveBundledPluginTranslationLocaleDirectory(rootDir),
  ];
}
