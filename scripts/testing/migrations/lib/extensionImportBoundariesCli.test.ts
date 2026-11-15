import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const command = fileURLToPath(new URL('../validateExtensionImportBoundaries.ts', import.meta.url));

test('boundary CLI checks selected files from Git NUL lists and preserves the full scan', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-plugin-boundary-cli-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src'), { recursive: true });
  writeFileSync(join(rootDir, 'packages/plugins/acme/src/valid.ts'), 'export const valid = true;');
  writeFileSync(join(rootDir, 'packages/plugins/acme/src/invalid.ts'), "export * from '@happier-dev/agents';");
  const list = join(rootDir, 'changed-files');
  writeFileSync(list, 'packages/plugins/acme/src/valid.ts\0');
  const run = (args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', command, ...args], {
    cwd: rootDir, encoding: 'utf8',
  });
  assert.equal(run([`--files-from0=${list}`]).status, 0);
  const invalid = run(['--file=packages/plugins/acme/src/invalid.ts']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /forbidden-private-happier-import/);
  assert.equal(run([]).status, 1);
  assert.equal(run(['--unknown']).status, 1);
});
