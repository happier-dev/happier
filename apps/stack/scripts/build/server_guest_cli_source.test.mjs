// @happier-test-preparation source
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('the released server compiler selects public guest CLI artifacts', () => {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const outputDir = mkdtempSync(join(tmpdir(), 'happier-guest-cli-public-source-'));
  try {
    const entrypoint = join(outputDir, 'identity.ts');
    const outfile = join(outputDir, process.platform === 'win32' ? 'identity.exe' : 'identity');
    writeFileSync(entrypoint, 'console.log(typeof __HAPPIER_GUEST_CLI_SOURCE__ === "undefined" ? "missing" : __HAPPIER_GUEST_CLI_SOURCE__);');
    const compiled = spawnSync(process.env.HAPPIER_BUN_PATH || 'bun', [
      join(repoRoot, 'packages/cli-common/scripts/buildServerBunBinary.mjs'),
      `--target=bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`,
      `--entrypoint=${entrypoint}`, `--outfile=${outfile}`,
    ], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = spawnSync(outfile, [], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'public-release');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
