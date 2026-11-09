import { definePlugin, type PluginLanguageServerContributionV1 } from '@happier-dev/plugin-sdk';

const declaration = {
  id: 'example',
  title: 'Example language server',
  languageIds: { example: 'example-language' },
  executable: { kind: 'systemTool', id: 'example-tool' },
  args: ['--stdio'],
  projectCheck: { executable: { kind: 'systemTool', id: 'example-tool' }, args: ['--check'],
    projectFile: 'example.config.json', output: { kind: 'typescript' } },
  initializationOptions: { indexing: { enabled: false } },
  settings: { example: { diagnostics: true } },
} as const satisfies PluginLanguageServerContributionV1;

const { id: _id, ...server } = declaration;
export const plugin = definePlugin({
  id: 'com.example.language-server',
  version: '1.0.0',
  systemTools: { 'example-tool': { title: 'Example tool', executableNames: ['example-language-server'] } },
  languageServers: { example: server },
});

const command: PluginLanguageServerContributionV1 = {
  ...declaration,
  // @ts-expect-error Language servers reference declared executables, never arbitrary commands.
  command: 'example-language-server',
};
const projectBinary: PluginLanguageServerContributionV1 = {
  ...declaration,
  // @ts-expect-error Project-local executable paths are not an author launch contract.
  executable: { kind: 'projectLocalExecutable', path: './node_modules/.bin/example' },
};
const callback: PluginLanguageServerContributionV1 = {
  ...declaration,
  // @ts-expect-error This family has static declarations and no per-worktree resolver.
  resolve: () => declaration,
};
void [command, projectBinary, callback];
