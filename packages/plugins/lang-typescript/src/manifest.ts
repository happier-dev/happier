import { definePlugin } from '@happier-dev/plugin-sdk';

// Native TypeScript advertises inlay hints but defaults their production off.
// Enable the producer once; each editor's Off/Parameters/All preference owns demand and display.
const languageSettings = {
  inlayHints: {
    parameterNames: { enabled: 'all' },
    variableTypes: { enabled: true },
    functionLikeReturnTypes: { enabled: true },
  },
};

// The platform archives retain the adjacent standard-library declarations.
// Digests and layout were measured against the 7.1.0-beta npm platform archives.
export const LANG_TYPESCRIPT_PLUGIN = definePlugin({
  id: 'happier.language.typescript', version: '0.0.0', displayName: 'TypeScript',
  description: 'TypeScript and JavaScript language intelligence on the workspace Machine.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  languageServers: {
    typescript: {
      title: 'TypeScript',
      languageIds: { typescript: 'typescript', tsx: 'typescriptreact', javascript: 'javascript', jsx: 'javascriptreact' },
      executable: { kind: 'managedDependency', id: 'typescript-native' }, args: ['--lsp', '--stdio'],
      initializationOptions: {
        userPreferences: { tsserver: { automaticTypeAcquisition: { enabled: false } } },
        disablePushDiagnostics: true,
      },
      settings: { 'js/ts': languageSettings, typescript: languageSettings, javascript: languageSettings },
    },
  },
  managedDependencies: {
    'typescript-native': {
      title: 'TypeScript language server', executable: 'tsc',
      platforms: ['linux', 'macos', 'windows'], architectures: ['x64', 'arm64'],
      sources: [{ kind: 'pinnedArchive', installId: 'dep.typescript-native', version: '7.1.0-beta', assetsByPlatform: {
        'linux-x64': {
          archiveUrl: 'https://registry.npmjs.org/@typescript/typescript-linux-x64/-/typescript-linux-x64-7.1.0-beta.tgz',
          sha256: '59128685cb55f44c9e6644ef5edb3cb321618d9547b4ee94c3038598ffd51855',
          sizeBytes: 10175135, executableSubpath: 'package/lib/tsc',
        },
        'linux-arm64': {
          archiveUrl: 'https://registry.npmjs.org/@typescript/typescript-linux-arm64/-/typescript-linux-arm64-7.1.0-beta.tgz',
          sha256: 'd4a8b647be7417178be3ba5f1366cd83976af9b2ab5beb8755e2f9cfc00ee540',
          sizeBytes: 9375190, executableSubpath: 'package/lib/tsc',
        },
        'darwin-x64': {
          archiveUrl: 'https://registry.npmjs.org/@typescript/typescript-darwin-x64/-/typescript-darwin-x64-7.1.0-beta.tgz',
          sha256: '7123fd034c5a1d019f294b34d155f9ba0fd1d39aa671af61c34e978a955ec989',
          sizeBytes: 10586661, executableSubpath: 'package/lib/tsc',
        },
        'darwin-arm64': {
          archiveUrl: 'https://registry.npmjs.org/@typescript/typescript-darwin-arm64/-/typescript-darwin-arm64-7.1.0-beta.tgz',
          sha256: 'ec13640298a303ee474e83d9160e62e931da5cda8b6e188b2c4d342867fbd650',
          sizeBytes: 9776273, executableSubpath: 'package/lib/tsc',
        },
        'win32-x64': {
          archiveUrl: 'https://registry.npmjs.org/@typescript/typescript-win32-x64/-/typescript-win32-x64-7.1.0-beta.tgz',
          sha256: 'f918f45b0ed148768015b437aeecf1b6b9c3a3d390256d2bb37299f8b5e05884',
          sizeBytes: 10283326, executableSubpath: 'package/lib/tsc.exe',
        },
        'win32-arm64': {
          archiveUrl: 'https://registry.npmjs.org/@typescript/typescript-win32-arm64/-/typescript-win32-arm64-7.1.0-beta.tgz',
          sha256: '9fd1a4e28f9d98a5c7aa6349c17c215345a784e86f91f59c6b1d129599a25e5e',
          sizeBytes: 9385247, executableSubpath: 'package/lib/tsc.exe',
        },
      } }],
    },
  },
});

export const { manifest: PLUGIN_MANIFEST, activate } = LANG_TYPESCRIPT_PLUGIN;
