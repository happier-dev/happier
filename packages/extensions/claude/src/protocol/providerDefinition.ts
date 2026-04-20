import type { ProviderDefinitionV1 } from '@happier-dev/protocol';

// Data-only provider definition for future extension registration.
// Intentionally not registered yet; `activate()` remains inert in this wave.
export const CLAUDE_PROVIDER_DEFINITION: ProviderDefinitionV1 = {
  kindVersion: 1,
  id: 'claude',
  providerAgentId: 'claude',
  iconAgentId: 'claude',
  settingsBackendId: 'claude',
  display: {
    name: 'Claude',
    subtitle: 'Anthropic',
    tags: [],
  },
  providerCliRuntime: {
    kindVersion: 1,
    id: 'claude',
    title: 'Claude Code CLI',
    binaryName: 'claude',
    knownUserBinDirSuffixes: ['.local/bin'],
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'vendor_recipe',
    manualInstallRecipes: {
      darwin: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'] }],
      linux: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'] }],
      win32: [{ cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'] }],
    },
    acceptsJavaScriptFileOverride: true,
    installGuideUrl: 'https://code.claude.com/docs/en/setup',
    docsUrl: 'https://claude.ai',
  },
  ownedBackendIds: ['claude'],
};
