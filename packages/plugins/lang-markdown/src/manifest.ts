import { definePlugin } from '@happier-dev/plugin-sdk';

const release = 'https://github.com/artempyanykh/marksman/releases/download/2026-02-08/';
const mac = { archiveUrl: `${release}marksman-macos`, kind: 'executable' as const, executableSubpath: 'marksman',
  sizeBytes: 43856208, sha256: '6a801c17b5ac0dba69787c5282b3b3bd416e66c96253fae098d311c6bbd1833b' };

export const LANG_MARKDOWN_PLUGIN = definePlugin({
  id: 'happier.language.markdown', version: '0.0.0', displayName: 'Markdown',
  description: 'Markdown links, headings, references and diagnostics on the workspace Machine.',
  languageServers: { markdown: { title: 'Markdown', languageIds: { markdown: 'markdown' }, filePatterns: ['*.md', '*.markdown', '*.mdown'],
    rootMarkers: ['.marksman.toml', '.git'], executable: { kind: 'managedDependency', id: 'marksman' }, args: ['server'] } },
  managedDependencies: { marksman: { title: 'Marksman', executable: 'marksman',
    platforms: ['linux', 'macos', 'windows'], architectures: ['x64', 'arm64'],
    sources: [{ kind: 'pinnedArchive', installId: 'dep.marksman-language-server', version: '2026-02-08', assetsByPlatform: {
      'linux-x64': { archiveUrl: `${release}marksman-linux-x64`, kind: 'executable', executableSubpath: 'marksman',
        sizeBytes: 22500875, sha256: 'be5098e8213219269c47fc0d916a66fa31ce0602ec967475c722260aabf26087' },
      'linux-arm64': { archiveUrl: `${release}marksman-linux-arm64`, kind: 'executable', executableSubpath: 'marksman',
        sizeBytes: 21851058, sha256: 'db8e124527f7f8048e3e6c91821b9c52ef173d92c01e47d221bf1337afd962fb' },
      'darwin-x64': mac, 'darwin-arm64': mac,
      'win32-x64': { archiveUrl: `${release}marksman.exe`, kind: 'executable', executableSubpath: 'marksman.exe',
        sizeBytes: 20502938, sha256: 'a6d05beb08ebe41b0a9f09c98a438540421436fa5531424c22e0bb1d22529705' },
    } }] } },
});

export const { manifest: PLUGIN_MANIFEST, activate } = LANG_MARKDOWN_PLUGIN;
