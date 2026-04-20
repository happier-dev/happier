import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateExtensionImportBoundaries } from './extensionImportBoundaries.ts';

test('extension import boundary validator passes when no packages/extensions exist', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages'), { recursive: true });

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('extension import boundary validator flags @/ alias imports', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/extensions/acme/src'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/extensions/acme/src/index.ts'),
    "import { something } from '@/api/types';\nexport const ok = true;\n",
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('packages/extensions/acme/src/index.ts')));
  assert.ok(result.errors.some((error) => error.includes("\"@/api/types\"")));
});

test('extension import boundary validator flags apps/** imports', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/extensions/acme/src'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/extensions/acme/src/index.ts'),
    "import { something } from 'apps/cli/src/whatever';\nexport const ok = true;\n",
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("\"apps/cli/src/whatever\"")));
});

test('extension import boundary validator flags relative-path escapes from the extension package root', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/extensions/acme/src'), { recursive: true });
  mkdirSync(join(rootDir, 'apps/cli/src'), { recursive: true });
  writeFileSync(join(rootDir, 'apps/cli/src/whatever.ts'), 'export const whatever = true;\n', 'utf8');
  writeFileSync(
    join(rootDir, 'packages/extensions/acme/src/index.ts'),
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
  mkdirSync(join(rootDir, 'packages/extensions/acme/src/shared'), { recursive: true });
  writeFileSync(join(rootDir, 'packages/extensions/acme/src/shared/thing.ts'), 'export const thing = 123;\n', 'utf8');
  writeFileSync(
    join(rootDir, 'packages/extensions/acme/src/index.ts'),
    "import { thing } from './shared/thing';\nexport const ok = thing;\n",
    'utf8',
  );

  const result = validateExtensionImportBoundaries({ rootDir });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});
