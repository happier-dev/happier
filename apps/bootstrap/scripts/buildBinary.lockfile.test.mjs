import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const lockModule = join(repoRoot, 'packages/cli-common/src/firstPartyRuntime/withFirstPartyPayloadMutationLock.ts');

test('a compiled Bun lock mutation entry can load proper-lockfile', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'hsetup-lockfile-bundle-'));
  try {
    const entrypoint = join(tempRoot, 'entry.ts');
    const outfile = join(tempRoot, process.platform === 'win32' ? 'lock-test.exe' : 'lock-test');
    writeFileSync(entrypoint, `
      import { mkdir } from 'node:fs/promises';
      import { join } from 'node:path';
      import { withFirstPartyPayloadMutationLock } from ${JSON.stringify(lockModule)};
      const root = ${JSON.stringify(join(tempRoot, 'payload'))};
      await mkdir(root, { recursive: true });
      await withFirstPartyPayloadMutationLock({
        installRoot: root,
        lockParentDir: ${JSON.stringify(tempRoot)},
        operation: async () => undefined,
      });
      process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
    `, 'utf8');
    execFileSync('bun', ['build', '--compile', '--no-cache', entrypoint, '--outfile', outfile], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    const output = execFileSync(outfile, [], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
    assert.deepEqual(JSON.parse(output), { ok: true });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
