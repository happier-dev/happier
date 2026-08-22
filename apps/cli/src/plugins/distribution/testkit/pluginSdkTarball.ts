import { createTestNpmTarball } from './npmTarball';

/**
 * The one stand-in `@happier-dev/plugin-sdk` npm package for tests that must
 * resolve the SDK through a registry instead of the workspace, because pack and
 * the author toolchain deliberately evaluate an operation-local copy that has no
 * source-local `node_modules`.
 *
 * It projects the current flat `definePlugin` author input into the
 * `{ manifest, activate }` module ABI the host loads. A fixture still written
 * against the retired nested `manifest:` shape therefore projects a manifest
 * without `id`/`version` and fails canonical manifest ingestion, instead of
 * passing through an identity stub that proves nothing.
 */
export async function createTestPluginSdkTarball(): Promise<Buffer> {
  return await createTestNpmTarball([
    {
      name: 'package/package.json',
      body: JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        version: '0.0.0',
        type: 'module',
        exports: {
          '.': './index.js',
          './protocol': './protocol.js',
        },
      }),
    },
    {
      name: 'package/API.md',
      body: '# Plugin SDK API surface\n\n> Generated from `api-surface.json`. Do not hand-edit.\n',
    },
    { name: 'package/index.js', body: DEFINE_PLUGIN_STUB_SOURCE },
    { name: 'package/protocol.js', body: PROTOCOL_STUB_SOURCE },
  ]);
}

const DEFINE_PLUGIN_STUB_SOURCE = [
  'export function definePlugin(specification) {',
  '  const actions = Object.entries(specification.actions ?? {}).map(([id, action]) => {',
  '    const { run, ...declaration } = action;',
  '    return {',
  '      ...declaration,',
  '      id,',
  '      ...(action.inputSchema === undefined ? {} : { inputSchema: action.inputSchema.jsonSchema }),',
  '      ...(action.resultSchema === undefined ? {} : { resultSchema: action.resultSchema.jsonSchema }),',
  '    };',
  '  });',
  '  return {',
  '    manifest: {',
  '      schemaVersion: 2,',
  '      id: specification.id,',
  '      version: specification.version,',
  '      displayName: specification.displayName ?? specification.id,',
  '      ...(specification.description === undefined ? {} : { description: specification.description }),',
  "      engines: specification.engines ?? { happier: '>=0.0.0' },",
  '      runtime: specification.runtime ?? { apiVersion: 1 },',
  '      ...(specification.entrypoints === undefined ? {} : { entrypoints: specification.entrypoints }),',
  '      hostAccess: specification.hostAccess ?? { required: [], optional: [] },',
  '      contributes: actions.length === 0 ? {} : { actions },',
  '    },',
  '    activate(api) {',
  '      for (const [id, action] of Object.entries(specification.actions ?? {})) {',
  '        api.actions.register(id, action.run);',
  '      }',
  '    },',
  '  };',
  '}',
  '',
].join('\n');

const PROTOCOL_STUB_SOURCE = [
  'function schema(jsonSchema, parse) {',
  '  return {',
  '    jsonSchema,',
  '    parse,',
  '    safeParse(value) {',
  '      try { return { success: true, data: parse(value) }; }',
  '      catch (error) { return { success: false, error }; }',
  '    },',
  '    optional() { return this; },',
  '    nullable() { return this; },',
  '  };',
  '}',
  'export function defineProtocolString() {',
  "  return schema({ type: 'string' }, (value) => {",
  "    if (typeof value !== 'string') throw new TypeError('string required');",
  '    return value;',
  '  });',
  '}',
  'export function defineProtocolObject(shape) {',
  '  return schema({',
  "    type: 'object',",
  '    properties: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, value.jsonSchema])),',
  '    required: Object.keys(shape),',
  '    additionalProperties: false,',
  '  }, (value) => value);',
  '}',
  '',
].join('\n');
