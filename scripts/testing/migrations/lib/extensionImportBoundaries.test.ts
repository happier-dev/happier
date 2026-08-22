import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { validateExtensionImportBoundaries } from './extensionImportBoundaries.ts';

test('extension import boundary validator passes when no packages/plugins exist', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages'), { recursive: true });

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('extension import boundary validator flags @/ alias imports', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/index.ts'),
    "import { something } from '@/api/types';\nexport const ok = true;\n",
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('packages/plugins/acme/src/index.ts')));
  assert.ok(result.errors.some((error) => error.includes("\"@/api/types\"")));
});

test('extension import boundary validator flags apps/** imports', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/index.ts'),
    "import { something } from 'apps/cli/src/whatever';\nexport const ok = true;\n",
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("\"apps/cli/src/whatever\"")));
});

test('extension import boundary validator flags relative-path escapes from the extension package root', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src'), { recursive: true });
  mkdirSync(join(rootDir, 'apps/cli/src'), { recursive: true });
  writeFileSync(join(rootDir, 'apps/cli/src/whatever.ts'), 'export const whatever = true;\n', 'utf8');
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/index.ts'),
    "import { whatever } from '../../../../apps/cli/src/whatever';\nexport const ok = whatever;\n",
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('relative-escape')));
  assert.ok(result.errors.some((error) => error.includes('apps/cli/src/whatever')));
});

test('extension import boundary validator permits host-owner imports in plugin integration tests', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src'), { recursive: true });
  mkdirSync(join(rootDir, 'apps/cli/src'), { recursive: true });
  writeFileSync(join(rootDir, 'apps/cli/src/whatever.ts'), 'export const whatever = true;\n', 'utf8');
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/index.test.ts'),
    "import { whatever } from '../../../../apps/cli/src/whatever';\nexport const ok = whatever;\n",
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('extension import boundary validator permits excluded plugin test-support owners', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src'), { recursive: true });
  mkdirSync(join(rootDir, 'apps/cli/src'), { recursive: true });
  writeFileSync(join(rootDir, 'apps/cli/src/whatever.ts'), 'export const whatever = true;\n', 'utf8');
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/index.test-support.ts'),
    "import { whatever } from '../../../../apps/cli/src/whatever';\nexport const ok = whatever;\n",
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/index.testkit.ts'),
    "import { whatever } from '../../../../apps/cli/src/whatever';\nexport const ok = whatever;\n",
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('extension import boundary validator allows intra-package relative imports', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src/shared'), { recursive: true });
  writeFileSync(join(rootDir, 'packages/plugins/acme/src/shared/thing.ts'), 'export const thing = 123;\n', 'utf8');
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/index.ts'),
    "import { thing } from './shared/thing';\nexport const ok = thing;\n",
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('extension import boundary validator rejects production imports of plugin test-support and testkit paths', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src/shared'), { recursive: true });
  mkdirSync(join(rootDir, 'packages/plugins/acme/src/testkit'), { recursive: true });
  writeFileSync(join(rootDir, 'packages/plugins/acme/src/shared/thing.ts'), 'export const thing = true;\n', 'utf8');
  writeFileSync(join(rootDir, 'packages/plugins/acme/src/testkit/runtime.ts'), 'export const runtime = true;\n', 'utf8');
  writeFileSync(join(rootDir, 'packages/plugins/acme/src/session.test-support.ts'), 'export const support = true;\n', 'utf8');
  writeFileSync(join(rootDir, 'packages/plugins/acme/src/session.testkit.ts'), 'export const session = true;\n', 'utf8');
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/index.ts'),
    [
      "import { thing } from './shared/thing';",
      "import { support } from './session.test-support';",
      "import { session } from './session.testkit.js';",
      "import { runtime } from './testkit/runtime';",
      'export const ok = [thing, support, session, runtime];',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/index.test.ts'),
    "import { runtime } from './testkit/runtime';\nexport const ok = runtime;\n",
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.deepEqual(
    result.violations.filter((violation) => violation.kind === 'forbidden-test-support-import'),
    [
      {
        filePath: 'packages/plugins/acme/src/index.ts',
        specifier: './session.test-support',
        kind: 'forbidden-test-support-import',
        details: 'Plugin production code must not import test-support or testkit modules.',
      },
      {
        filePath: 'packages/plugins/acme/src/index.ts',
        specifier: './session.testkit.js',
        kind: 'forbidden-test-support-import',
        details: 'Plugin production code must not import test-support or testkit modules.',
      },
      {
        filePath: 'packages/plugins/acme/src/index.ts',
        specifier: './testkit/runtime',
        kind: 'forbidden-test-support-import',
        details: 'Plugin production code must not import test-support or testkit modules.',
      },
    ],
  );
  assert.ok(result.violations.every((violation) => violation.specifier !== './shared/thing'));
});

test('extension import boundary validator rejects package-import aliases without resolving private mappings', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src'), { recursive: true });
  mkdirSync(join(rootDir, 'packages/plugin-sdk'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/package.json'),
    JSON.stringify({
      name: '@happier-dev/plugins-acme',
      dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      imports: { '#sdk': '@happier-dev/plugin-sdk' },
    }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugin-sdk/api-surface.json'),
    JSON.stringify({ schemaVersion: 1, entrypoints: [{ specifier: '.', visibility: 'author' }] }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/index.ts'),
    [
      "import { direct } from '@happier-dev/plugin-sdk';",
      "import { hidden } from '#sdk';",
      'export const ok = direct ?? hidden;',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.deepEqual(
    result.violations.filter((violation) => violation.kind === 'forbidden-alias'),
    [{
      filePath: 'packages/plugins/acme/src/index.ts',
      specifier: '#sdk',
      kind: 'forbidden-alias',
      details: 'Plugin production package-import aliases (#...) are not an approved public boundary.',
    }],
  );
  assert.ok(result.violations.every((violation) => violation.specifier !== '@happier-dev/plugin-sdk'));
});

test('extension import boundary validator rejects direct protocol imports from plugin production source', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src/provider'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/package.json'),
    JSON.stringify({ name: '@happier-dev/plugins-acme', dependencies: { '@happier-dev/plugin-sdk': '0.0.0' } }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/provider/contribution.ts'),
    "import { ProviderContributionV1Schema } from '@happier-dev/protocol';\nexport const ok = true;\n",
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => (
    violation.kind === 'forbidden-protocol-import'
    && violation.filePath === 'packages/plugins/acme/src/provider/contribution.ts'
    && violation.specifier === '@happier-dev/protocol'
  )));
});

test('extension import boundary validator rejects Protocol runtime dependencies retained only for plugin tests', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/test-only/src'), { recursive: true });
  mkdirSync(join(rootDir, 'packages/plugins/scm/src'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/test-only/package.json'),
    JSON.stringify({
      name: '@happier-dev/plugins-test-only',
      dependencies: { '@happier-dev/protocol': '0.0.0' },
    }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/test-only/src/runtime.test.ts'),
    "import { PluginManifestV2Schema } from '@happier-dev/protocol';\nexport const ok = PluginManifestV2Schema;\n",
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/scm/package.json'),
    JSON.stringify({
      name: '@happier-dev/plugins-scm',
      dependencies: { '@happier-dev/protocol': '0.0.0' },
    }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/scm/src/event.ts'),
    "import { PluginManifestV2Schema } from '@happier-dev/protocol';\nexport const ok = PluginManifestV2Schema;\n",
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.deepEqual(
    result.violations.filter((violation) => violation.kind === 'unneeded-runtime-protocol-dependency'),
    [{
      filePath: 'packages/plugins/test-only/package.json',
      specifier: '@happier-dev/protocol',
      kind: 'unneeded-runtime-protocol-dependency',
      details: 'Plugin package declares @happier-dev/protocol as a runtime dependency but no production source imports it; move it to devDependencies or remove it.',
    }],
  );
  assert.deepEqual(
    result.violations.filter((violation) => violation.kind === 'forbidden-protocol-import'),
    [{
      filePath: 'packages/plugins/scm/src/event.ts',
      specifier: '@happier-dev/protocol',
      kind: 'forbidden-protocol-import',
      details: 'Plugin production code must consume public contracts through @happier-dev/plugin-sdk; do not bypass the SDK boundary.',
    }],
  );
});

test('extension import boundary validator admits published feature-protocol exports while rejecting private Protocol and Agents packages', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src'), { recursive: true });
  mkdirSync(join(rootDir, 'packages/triage-protocol'), { recursive: true });
  mkdirSync(join(rootDir, 'packages/private-protocol'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/triage-protocol/package.json'),
    JSON.stringify({
      name: '@happier-dev/triage-protocol',
      private: false,
      exports: {
        '.': './dist/index.js',
        './v1': './dist/v1/index.js',
        './testing/v1': './dist/testing/v1/index.js',
      },
    }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/private-protocol/package.json'),
    JSON.stringify({
      name: '@happier-dev/private-protocol',
      private: true,
      exports: {
        '.': './dist/index.js',
        './v1': './dist/v1/index.js',
        './testing/v1': './dist/testing/v1/index.js',
      },
    }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/package.json'),
    JSON.stringify({
      name: '@happier-dev/plugins-acme',
      dependencies: {
        '@happier-dev/agents': '0.0.0',
        '@happier-dev/private-protocol': '0.0.0',
        '@happier-dev/protocol': '0.0.0',
        '@happier-dev/triage-protocol': '0.0.0',
      },
    }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/contribution.ts'),
    [
      "import { triageProtocol } from '@happier-dev/triage-protocol/v1';",
      "import { privateAgent } from '@happier-dev/agents';",
      "import { privateProtocol } from '@happier-dev/protocol';",
      "import { hiddenProtocol } from '@happier-dev/private-protocol/v1';",
      'export const ok = [triageProtocol, privateAgent, privateProtocol, hiddenProtocol];',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.deepEqual(result.violations, [
    {
      filePath: 'packages/plugins/acme/src/contribution.ts',
      specifier: '@happier-dev/agents',
      kind: 'forbidden-private-happier-import',
      details: 'External-shaped plugin production code may import only public Plugin SDK/UI paths or public feature-protocol package exports.',
    },
    {
      filePath: 'packages/plugins/acme/src/contribution.ts',
      specifier: '@happier-dev/private-protocol/v1',
      kind: 'forbidden-private-happier-import',
      details: 'External-shaped plugin production code may import only public Plugin SDK/UI paths or public feature-protocol package exports.',
    },
    {
      filePath: 'packages/plugins/acme/src/contribution.ts',
      specifier: '@happier-dev/protocol',
      kind: 'forbidden-protocol-import',
      details: 'Plugin production code must consume public contracts through @happier-dev/plugin-sdk; do not bypass the SDK boundary.',
    },
  ]);
});

test('extension import boundary validator default-denies declared private @happier-dev packages', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src/agent'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/package.json'),
    JSON.stringify({
      name: '@happier-dev/plugins-acme',
      dependencies: {
        '@happier-dev/agents': '0.0.0',
        '@happier-dev/plugin-sdk': '0.0.0',
        '@happier-dev/plugin-ui': '0.0.0',
      },
    }),
    'utf8',
  );
  mkdirSync(join(rootDir, 'packages/plugin-sdk'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugin-sdk/api-surface.json'),
    JSON.stringify({
      schemaVersion: 1,
      entrypoints: [
        { specifier: '.', visibility: 'author' },
        { specifier: './agents/runtime', visibility: 'author' },
        { specifier: './host/registration', visibility: 'host' },
      ],
    }),
    'utf8',
  );
  mkdirSync(join(rootDir, 'packages/plugin-ui'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugin-ui/package.json'),
    JSON.stringify({ exports: { '.': './dist/index.js' } }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/agent/runtime.ts'),
    [
      "import { privateRuntime } from '@happier-dev/agents';",
      "import { createPluginRegistrationScope } from '@happier-dev/plugin-sdk/host/registration';",
      "import { missingPublicProjection } from '@happier-dev/plugin-sdk/not-public';",
      "import type { AgentRuntime } from '@happier-dev/plugin-sdk/agents/runtime';",
      "import { usePluginUi } from '@happier-dev/plugin-ui';",
      'export const ok: AgentRuntime | null = privateRuntime && createPluginRegistrationScope && missingPublicProjection ? null : usePluginUi;',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.deepEqual(
    result.violations.filter((violation) => violation.kind === 'forbidden-private-happier-import'),
    [
      {
        filePath: 'packages/plugins/acme/src/agent/runtime.ts',
        specifier: '@happier-dev/agents',
        kind: 'forbidden-private-happier-import',
        details: 'External-shaped plugin production code may import only public Plugin SDK/UI paths or public feature-protocol package exports.',
      },
      {
        filePath: 'packages/plugins/acme/src/agent/runtime.ts',
        specifier: '@happier-dev/plugin-sdk/host/registration',
        kind: 'forbidden-private-happier-import',
        details: 'External-shaped plugin production code may import only public Plugin SDK/UI paths or public feature-protocol package exports.',
      },
      {
        filePath: 'packages/plugins/acme/src/agent/runtime.ts',
        specifier: '@happier-dev/plugin-sdk/not-public',
        kind: 'forbidden-private-happier-import',
        details: 'External-shaped plugin production code may import only public Plugin SDK/UI paths or public feature-protocol package exports.',
      },
    ],
  );
});

test('extension import boundary validator admits a public shared package authored only against the public author surface', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src'), { recursive: true });
  mkdirSync(join(rootDir, 'packages/plugin-sdk'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugin-sdk/api-surface.json'),
    JSON.stringify({
      schemaVersion: 1,
      entrypoints: [
        { specifier: '.', visibility: 'author' },
        { specifier: './ui', visibility: 'author' },
        { specifier: './host/registration', visibility: 'host' },
      ],
    }),
    'utf8',
  );
  mkdirSync(join(rootDir, 'packages/plugin-ui'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugin-ui/package.json'),
    JSON.stringify({ exports: { '.': './dist/index.js' } }),
    'utf8',
  );

  // Declares itself public AND imports only already-public author specifiers.
  mkdirSync(join(rootDir, 'packages/shared-public/src'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/shared-public/package.json'),
    JSON.stringify({
      name: '@happier-dev/shared-public',
      private: false,
      exports: { '.': './dist/index.js' },
    }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/shared-public/src/index.ts'),
    [
      "import { RenderSurface } from '@happier-dev/plugin-sdk/ui';",
      "import { Text } from '@happier-dev/plugin-ui';",
      'export const surface = [RenderSurface, Text];',
      '',
    ].join('\n'),
    'utf8',
  );
  // Test-only host-private import must not affect the package's admission.
  writeFileSync(
    join(rootDir, 'packages/shared-public/src/index.test.ts'),
    "import { privateAgent } from '@happier-dev/agents';\nvoid privateAgent;\n",
    'utf8',
  );

  // Declares itself public but holds a host-private import of its own.
  mkdirSync(join(rootDir, 'packages/shared-leaky/src'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/shared-leaky/package.json'),
    JSON.stringify({
      name: '@happier-dev/shared-leaky',
      private: false,
      exports: { '.': './dist/index.js' },
    }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/shared-leaky/src/index.ts'),
    "import { privateAgent } from '@happier-dev/agents';\nexport const leak = privateAgent;\n",
    'utf8',
  );

  // Identical clean sources, but never declares itself public.
  mkdirSync(join(rootDir, 'packages/shared-undeclared/src'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/shared-undeclared/package.json'),
    JSON.stringify({
      name: '@happier-dev/shared-undeclared',
      private: true,
      exports: { '.': './dist/index.js' },
    }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/shared-undeclared/src/index.ts'),
    "import { Text } from '@happier-dev/plugin-ui';\nexport const text = Text;\n",
    'utf8',
  );

  writeFileSync(
    join(rootDir, 'packages/plugins/acme/package.json'),
    JSON.stringify({
      name: '@happier-dev/plugins-acme',
      dependencies: {
        '@happier-dev/shared-leaky': '0.0.0',
        '@happier-dev/shared-public': '0.0.0',
        '@happier-dev/shared-undeclared': '0.0.0',
      },
    }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/contribution.ts'),
    [
      "import { surface } from '@happier-dev/shared-public';",
      "import { leak } from '@happier-dev/shared-leaky';",
      "import { text } from '@happier-dev/shared-undeclared';",
      'export const ok = [surface, leak, text];',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.deepEqual(
    result.violations.filter((violation) => violation.kind === 'forbidden-private-happier-import'),
    [
      {
        filePath: 'packages/plugins/acme/src/contribution.ts',
        specifier: '@happier-dev/shared-leaky',
        kind: 'forbidden-private-happier-import',
        details: 'External-shaped plugin production code may import only public Plugin SDK/UI paths or public feature-protocol package exports.',
      },
      {
        filePath: 'packages/plugins/acme/src/contribution.ts',
        specifier: '@happier-dev/shared-undeclared',
        kind: 'forbidden-private-happier-import',
        details: 'External-shaped plugin production code may import only public Plugin SDK/UI paths or public feature-protocol package exports.',
      },
    ],
  );
});

test('extension import boundary validator scopes privileged adapter exceptions to an exact file and specifier', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  const privilegedFile = 'packages/plugins/opencode/src/agent/auth/services/requestAuth/assets.ts';
  const neighboringFile = 'packages/plugins/opencode/src/agent/auth/services/requestAuth/unapproved.ts';
  for (const filePath of [privilegedFile, neighboringFile]) {
    const absolutePath = join(rootDir, filePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(
      absolutePath,
      "import { requestAuth } from '@happier-dev/agents/request-auth';\nexport const ok = requestAuth;\n",
      'utf8',
    );
  }
  writeFileSync(
    join(rootDir, 'packages/plugins/opencode/package.json'),
    JSON.stringify({
      name: '@happier-dev/plugins-opencode',
      dependencies: { '@happier-dev/agents': '0.0.0' },
    }),
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.deepEqual(
    result.violations.filter((violation) => violation.kind === 'forbidden-private-happier-import'),
    [{
      filePath: neighboringFile,
      specifier: '@happier-dev/agents/request-auth',
      kind: 'forbidden-private-happier-import',
      details: 'External-shaped plugin production code may import only public Plugin SDK/UI paths or public feature-protocol package exports.',
    }],
  );
});

test('extension import boundary validator rejects every retired protocol-import exception path', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  const retiredProtocolImportExceptions = [
    'packages/plugins/elevenlabs/src/agent/voice/provider.ts',
    'packages/plugins/elevenlabs/src/protocol/voice/index.ts',
    'packages/plugins/elevenlabs/src/ui/voice/autoprovision.ts',
    'packages/plugins/elevenlabs/src/ui/voice/runtime.ts',
    'packages/plugins/elevenlabs/src/ui/voice/runtime/eventMapper.ts',
    'packages/plugins/elevenlabs/src/ui/voice/runtime/protocol.ts',
    'packages/plugins/elevenlabs/src/ui/voice/runtime/sdkConnection.ts',
    'packages/plugins/elevenlabs/src/ui/voice/runtime/sessionPreparation.ts',
    'packages/plugins/elevenlabs/src/ui/voice/runtime/sessionTypes.ts',
    'packages/plugins/google/src/protocol/voice/index.ts',
    'packages/plugins/google/src/ui/voice/index.ts',
    'packages/plugins/openai/src/agent/voice/broker.ts',
    'packages/plugins/openai/src/ui/voice/connection.ts',
    'packages/plugins/openai/src/ui/voice/runtime.ts',
    'packages/plugins/openai/src/ui/voice/protocol.ts',
    'packages/plugins/xai/src/agent/voice/broker.ts',
    'packages/plugins/xai/src/ui/voice/connection.ts',
    'packages/plugins/xai/src/ui/voice/runtime.ts',
    'packages/plugins/xai/src/ui/voice/protocol.ts',
  ] as const;

  for (const filePath of retiredProtocolImportExceptions) {
    const absolutePath = join(rootDir, filePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(
      absolutePath,
      "import { VoiceProviderContributionSchema } from '@happier-dev/protocol';\nexport const ok = true;\n",
      'utf8',
    );
  }

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.deepEqual(
    result.violations
      .filter((violation) => violation.kind === 'forbidden-protocol-import')
      .map((violation) => violation.filePath),
    [...retiredProtocolImportExceptions].sort((left, right) => left.localeCompare(right)),
  );
});

test('extension import boundary validator permits protocol imports in plugin tests', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src/provider'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/package.json'),
    JSON.stringify({ name: '@happier-dev/plugins-acme' }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/provider/contribution.test.ts'),
    "import { ProviderContributionV1Schema } from '@happier-dev/protocol';\nexport const ok = true;\n",
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, true);
});

test('extension import boundary validator rejects undeclared production dependencies', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src/agent'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/package.json'),
    JSON.stringify({ name: '@happier-dev/plugins-acme', dependencies: {} }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/agent/runtime.ts'),
    "import { z } from 'zod';\nexport const ok = z.string();\n",
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => (
    violation.kind === 'undeclared-package-dependency'
    && violation.filePath === 'packages/plugins/acme/src/agent/runtime.ts'
    && violation.specifier === 'zod'
  )));
});

test('extension import boundary validator classifies declared npm alias targets', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src'), { recursive: true });
  mkdirSync(join(rootDir, 'packages/plugin-sdk'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/package.json'),
    JSON.stringify({
      name: '@happier-dev/plugins-acme',
      dependencies: {
        'agents-alias': 'npm:@happier-dev/agents@^1.0.0',
        'protocol-alias': 'npm:@happier-dev/protocol@1.2.3',
        'sdk-alias': 'npm:@happier-dev/plugin-sdk@^1.0.0',
        'external-alias': 'npm:zod@^3.0.0',
      },
    }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugin-sdk/api-surface.json'),
    JSON.stringify({ schemaVersion: 1, entrypoints: [{ specifier: '.', visibility: 'author' }] }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/index.ts'),
    [
      "import { privateValue } from 'agents-alias/runtime';",
      "import { schema } from 'protocol-alias/schema';",
      "import { publicValue } from 'sdk-alias';",
      "import { z } from 'external-alias';",
      'export const ok = [privateValue, schema, publicValue, z];',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.deepEqual(result.violations, [
    {
      filePath: 'packages/plugins/acme/src/index.ts',
      specifier: 'agents-alias/runtime',
      kind: 'forbidden-private-happier-import',
      details: 'External-shaped plugin production code may import only public Plugin SDK/UI paths or public feature-protocol package exports.',
    },
    {
      filePath: 'packages/plugins/acme/src/index.ts',
      specifier: 'protocol-alias/schema',
      kind: 'forbidden-protocol-import',
      details: 'Plugin production code must consume public contracts through @happier-dev/plugin-sdk; do not bypass the SDK boundary.',
    },
  ]);
});

test('extension import boundary validator preserves literal module-syntax coverage', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src/agent'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/package.json'),
    JSON.stringify({ name: '@happier-dev/plugins-acme', dependencies: {} }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/agent/runtime.ts'),
    [
      "export { value } from 'exported-package';",
      "export type Imported = import('typed-package').Imported;",
      "export const lazy = import('dynamic-package');",
      "export const legacy = require('required-package');",
      '',
    ].join('\n'),
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.deepEqual(
    result.violations.map((violation) => violation.specifier),
    ['dynamic-package', 'exported-package', 'required-package', 'typed-package'],
  );
});

test('extension import boundary validator rejects non-literal dynamic loads only in production plugin source', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src/agent'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/package.json'),
    JSON.stringify({ name: '@happier-dev/plugins-acme', dependencies: {} }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/agent/generatedExtension.ts'),
    [
      'export function buildGeneratedExtension(): string {',
      '  return `const lazy = import(moduleName); const legacy = require(packageName);`;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/agent/runtime.ts'),
    [
      'const moduleName = process.env.MODULE_NAME;',
      'const packageName = process.env.PACKAGE_NAME;',
      'export const lazy = import(moduleName);',
      'export const legacy = require(packageName);',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.deepEqual(
    result.violations.filter((violation) => violation.kind === 'non-literal-module-specifier'),
    [
      {
        filePath: 'packages/plugins/acme/src/agent/runtime.ts',
        specifier: 'import()',
        kind: 'non-literal-module-specifier',
        details: 'Plugin production dynamic import() must use a string-literal module specifier.',
      },
      {
        filePath: 'packages/plugins/acme/src/agent/runtime.ts',
        specifier: 'require()',
        kind: 'non-literal-module-specifier',
        details: 'Plugin production require() must use a string-literal module specifier.',
      },
    ],
  );
});

test('extension import boundary validator covers module.require and direct imported createRequire loaders', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/package.json'),
    JSON.stringify({
      name: '@happier-dev/plugins-acme',
      dependencies: {
        '@happier-dev/agents': '0.0.0',
        '@happier-dev/protocol': '0.0.0',
        'loader-factory': '1.0.0',
        zod: '^3.0.0',
      },
    }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/runtime.ts'),
    [
      "import { createRequire as makeRequire } from 'node:module';",
      'const load = makeRequire(import.meta.url);',
      'const moduleName = process.env.MODULE_NAME;',
      "export const privateMember = module.require('@happier-dev/agents');",
      "export const approvedMember = module.require('zod');",
      'export const unknownMember = module.require(moduleName);',
      "export const privateLoader = load('@happier-dev/protocol');",
      "export const approvedLoader = load('zod');",
      'export const unknownLoader = load(moduleName);',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/neighbor.ts'),
    [
      "import { createRequire } from 'node:module';",
      "import { createRequire as customFactory } from 'loader-factory';",
      'const directLoad = createRequire(import.meta.url);',
      'const unrelatedLoad = customFactory(import.meta.url);',
      'const moduleName = process.env.MODULE_NAME;',
      "export const privateLoader = directLoad('@happier-dev/agents');",
      'export const unrelated = unrelatedLoad(moduleName);',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.deepEqual(
    result.violations.filter((violation) => violation.kind === 'forbidden-private-happier-import'),
    [
      {
        filePath: 'packages/plugins/acme/src/neighbor.ts',
        specifier: '@happier-dev/agents',
        kind: 'forbidden-private-happier-import',
        details: 'External-shaped plugin production code may import only public Plugin SDK/UI paths or public feature-protocol package exports.',
      },
      {
        filePath: 'packages/plugins/acme/src/runtime.ts',
        specifier: '@happier-dev/agents',
        kind: 'forbidden-private-happier-import',
        details: 'External-shaped plugin production code may import only public Plugin SDK/UI paths or public feature-protocol package exports.',
      },
    ],
  );
  assert.deepEqual(
    result.violations.filter((violation) => violation.kind === 'forbidden-protocol-import'),
    [{
      filePath: 'packages/plugins/acme/src/runtime.ts',
      specifier: '@happier-dev/protocol',
      kind: 'forbidden-protocol-import',
      details: 'Plugin production code must consume public contracts through @happier-dev/plugin-sdk; do not bypass the SDK boundary.',
    }],
  );
  assert.deepEqual(
    result.violations.filter((violation) => violation.kind === 'non-literal-module-specifier'),
    [
      {
        filePath: 'packages/plugins/acme/src/runtime.ts',
        specifier: 'createRequire() loader',
        kind: 'non-literal-module-specifier',
        details: 'Plugin production createRequire() loaders must use a string-literal module specifier.',
      },
      {
        filePath: 'packages/plugins/acme/src/runtime.ts',
        specifier: 'module.require()',
        kind: 'non-literal-module-specifier',
        details: 'Plugin production module.require() must use a string-literal module specifier.',
      },
    ],
  );
});

test('extension import boundary validator excludes worker and fixture modules under __tests__', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src/__tests__/fixtures'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/__tests__/fixtures/worker.ts'),
    [
      "import { hostFixture } from '@/dev/testkit';",
      'export const loadFixture = (moduleName: string) => import(moduleName);',
      'export const fixture = hostFixture;',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('extension import boundary validator rejects copied generic runtime-descriptor compatibility readers', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  const copiedReader = [
    'export function readDescriptor(metadata: Record<string, unknown>) {',
    '  const descriptor = metadata.runtimeDescriptorV1 ?? metadata.agentRuntimeDescriptorV1;',
    '  if (!descriptor || typeof descriptor !== "object") return null;',
    '  const record = descriptor as Record<string, unknown>;',
    '  return { id: record.providerId, payload: record.provider, extra: record.providerExtra };',
    '}',
    '',
  ].join('\n');
  mkdirSync(join(rootDir, 'packages/plugins/acme/src/ui'), { recursive: true });
  mkdirSync(join(rootDir, 'packages/plugins/acme/src/protocol'), { recursive: true });
  mkdirSync(join(rootDir, 'packages/plugins/acme/src/agent/runtime'), { recursive: true });
  writeFileSync(join(rootDir, 'packages/plugins/acme/src/ui/runtimeMetadata.ts'), copiedReader, 'utf8');
  writeFileSync(join(rootDir, 'packages/plugins/acme/src/protocol/runtimeDescriptorV1.ts'), copiedReader, 'utf8');
  writeFileSync(join(rootDir, 'packages/plugins/acme/src/agent/runtime/runtimeDescriptor.ts'), copiedReader, 'utf8');

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.deepEqual(
    result.violations.filter((violation) => violation.kind === 'duplicate-runtime-descriptor-compatibility-reader'),
    [
      {
        filePath: 'packages/plugins/acme/src/ui/runtimeMetadata.ts',
        specifier: 'runtimeDescriptorV1|agentRuntimeDescriptorV1',
        kind: 'duplicate-runtime-descriptor-compatibility-reader',
        details: 'Generic plugin code must delegate legacy runtime-descriptor carrier/provider normalization to a plugin-native protocol or Agent runtime-descriptor codec.',
      },
    ],
  );
});

test('extension import boundary validator accepts declared production dependencies and Node builtins', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src/agent'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/package.json'),
    JSON.stringify({ name: '@happier-dev/plugins-acme', dependencies: { zod: '^3.0.0' } }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/agent/runtime.ts'),
    "import fs from 'fs';\nimport { readFile } from 'node:fs/promises';\nimport { z } from 'zod';\nexport const ok = [fs, readFile, z.string()];\n",
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, true);
});

test('extension import boundary validator distinguishes generated upstream source from plugin imports', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src/agent'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/package.json'),
    JSON.stringify({ name: '@happier-dev/plugins-acme', dependencies: {} }),
    'utf8',
  );
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/agent/generatedExtension.ts'),
    [
      'export function buildGeneratedExtension(): string {',
      '  return `import { toolApi } from "@vendor/tool-owned-api";\\nexport default toolApi;\\n`;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  const generatedOnly = validateExtensionImportBoundaries({ rootDir });
  assert.equal(generatedOnly.ok, true);
  assert.equal(generatedOnly.errors.length, 0);

  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/agent/runtime.ts'),
    "import { toolApi } from '@vendor/tool-owned-api';\nexport const runtime = toolApi;\n",
    'utf8',
  );

  const pluginImport = validateExtensionImportBoundaries({ rootDir });
  assert.equal(pluginImport.ok, false);
  assert.ok(pluginImport.violations.some((violation) => (
    violation.kind === 'undeclared-package-dependency'
    && violation.filePath === 'packages/plugins/acme/src/agent/runtime.ts'
    && violation.specifier === '@vendor/tool-owned-api'
  )));
  assert.ok(pluginImport.violations.every((violation) => (
    violation.filePath !== 'packages/plugins/acme/src/agent/generatedExtension.ts'
  )));
});
