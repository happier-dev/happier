import { definePlugin } from '@happier-dev/plugin-sdk';

// Each bin is selected from the pinned package's own metadata. The host installs
// its dependency graph explicitly and launches it through the managed JS runtime.
export const LANG_WEB_PLUGIN = definePlugin({
  id: 'happier.language.web', version: '0.0.0', displayName: 'Web languages',
  description: 'JSON, CSS, SCSS, Less and HTML language intelligence on the workspace Machine.',
  managedDependencies: {
    'json-executable': { title: 'JSON language server', executable: 'vscode-json-language-server',
      platforms: ['linux', 'macos', 'windows'], architectures: ['x64', 'arm64'],
      sources: [{ kind: 'managedJavaScriptPackage', installId: 'dep.web-json-language-server', packageName: 'vscode-langservers-extracted', version: '4.10.0' }] },
    'css-executable': { title: 'CSS language server', executable: 'vscode-css-language-server',
      platforms: ['linux', 'macos', 'windows'], architectures: ['x64', 'arm64'],
      sources: [{ kind: 'managedJavaScriptPackage', installId: 'dep.web-css-language-server', packageName: 'vscode-langservers-extracted', version: '4.10.0' }] },
    'html-executable': { title: 'HTML language server', executable: 'vscode-html-language-server',
      platforms: ['linux', 'macos', 'windows'], architectures: ['x64', 'arm64'],
      sources: [{ kind: 'managedJavaScriptPackage', installId: 'dep.web-html-language-server', packageName: 'vscode-langservers-extracted', version: '4.10.0' }] },
  },
  languageServers: {
    json: { title: 'JSON', languageIds: { json: 'json', jsonc: 'jsonc' }, filePatterns: ['*.json', '*.jsonc'],
      executable: { kind: 'managedDependency', id: 'json-executable' }, args: ['--stdio'],
      initializationOptionsSetting: { scope: 'daemon', field: 'jsonInitializationOptions' },
      settings: { json: { validate: { enable: true }, format: { enable: true } } } },
    css: { title: 'CSS', languageIds: { css: 'css', scss: 'scss', less: 'less' }, filePatterns: ['*.css', '*.scss', '*.less'],
      executable: { kind: 'managedDependency', id: 'css-executable' }, args: ['--stdio'],
      initializationOptions: { provideFormatter: true },
      settings: { css: { validate: true }, scss: { validate: true }, less: { validate: true } } },
    html: { title: 'HTML', languageIds: { html: 'html' }, filePatterns: ['*.html', '*.htm'],
      executable: { kind: 'managedDependency', id: 'html-executable' }, args: ['--stdio'],
      initializationOptions: { provideFormatter: true }, settings: { html: { format: { enable: true } } } },
  },
  settings: {
    'json-settings': { title: 'JSON', description: 'Choose how JSON language features load schemas on this Machine.',
      target: { kind: 'plugin' }, scope: 'daemon', fields: [{
        id: 'jsonInitializationOptions', title: 'Schema loading',
        description: 'Local schemas are enabled. Add https or http to handledSchemaProtocols to allow schema downloads, then restart the language server.',
        schema: { type: 'object', additionalProperties: false,
          properties: { provideFormatter: { type: 'boolean' }, handledSchemaProtocols: { type: 'array', items: { type: 'string', enum: ['file', 'https', 'http'] } } },
          required: ['provideFormatter', 'handledSchemaProtocols'] },
        default: { provideFormatter: true, handledSchemaProtocols: ['file'] }, presentation: { control: 'json' },
      }], presentation: { sections: [{ id: 'schemas', title: 'Schemas',
        description: 'Schema completion and validation use local schemas by default. Downloaded schemas may disclose the schema URL to its host.', fields: ['jsonInitializationOptions'] }] },
    },
  },
});

export const { manifest: PLUGIN_MANIFEST, activate } = LANG_WEB_PLUGIN;
