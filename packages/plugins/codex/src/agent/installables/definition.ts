import type { ManagedDependencyContribution } from '@happier-dev/plugin-sdk/managed-services';

export const CODEX_ACP_MANAGED_DEPENDENCY = {
  id: 'codex-acp',
  title: 'Codex ACP',
  description: 'Codex ACP dependency used by the Codex ACP backend',
  executable: 'codex-acp',
  sources: [{
    kind: 'githubReleaseBinary',
    installId: 'dep.codex-acp',
    repo: 'zed-industries/codex-acp',
    distTag: 'latest',
    archiveLayout: 'single_executable',
    assetNamePrefix: 'codex-acp',
    targetByPlatform: {
      'darwin-arm64': 'aarch64-apple-darwin',
      'darwin-x64': 'x86_64-apple-darwin',
      'win32-arm64': 'aarch64-pc-windows-msvc',
      'win32-x64': 'x86_64-pc-windows-msvc',
      'linux-arm64-gnu': 'aarch64-unknown-linux-gnu',
      'linux-arm64-musl': 'aarch64-unknown-linux-musl',
      'linux-x64-gnu': 'x86_64-unknown-linux-gnu',
      'linux-x64-musl': 'x86_64-unknown-linux-musl',
    },
    launch: {
      kind: 'configured_binary',
      overrideEnvironmentKey: 'HAPPIER_CODEX_ACP_BIN',
      configOverridesEnvironmentKey: 'HAPPIER_CODEX_ACP_CONFIG_OVERRIDES',
      configOverrideArgument: '-c',
      legacyExecutables: [
        { relativePath: 'node_modules/.bin/codex-acp.cmd', platforms: ['win32'], requiresManagedJavaScriptRuntime: true },
        { relativePath: 'node_modules/.bin/codex-acp.exe', platforms: ['win32'], requiresManagedJavaScriptRuntime: true },
        { relativePath: 'node_modules/.bin/codex-acp', requiresManagedJavaScriptRuntime: true },
      ],
    },
  }],
} as const satisfies ManagedDependencyContribution;
