import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
