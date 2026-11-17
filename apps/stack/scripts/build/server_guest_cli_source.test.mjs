// @happier-test-preparation source
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('the released server compiler preserves each published guest CLI channel', () => {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const outputDir = mkdtempSync(join(tmpdir(), 'happier-guest-cli-public-source-'));
  try {
    const entrypoint = join(outputDir, 'identity.ts');
    const outfile = join(outputDir, process.platform === 'win32' ? 'identity.exe' : 'identity');
    writeFileSync(entrypoint, 'console.log(JSON.stringify({ source: typeof __HAPPIER_GUEST_CLI_SOURCE__ === "undefined" ? null : __HAPPIER_GUEST_CLI_SOURCE__, channel: typeof __HAPPIER_GUEST_CLI_CHANNEL__ === "undefined" ? null : __HAPPIER_GUEST_CLI_CHANNEL__, guestExportAvailable: typeof __HAPPIER_DEV_GUEST_CLI_EXPORT_AVAILABLE__ === "undefined" ? null : __HAPPIER_DEV_GUEST_CLI_EXPORT_AVAILABLE__ }));');
    const launcher = join(outputDir, 'compile.ts');
    writeFileSync(launcher, `import { compileBunBinary } from ${JSON.stringify(join(repoRoot, 'packages/cli-common/src/componentArtifacts/commands.ts'))};
      await compileBunBinary({ repoRoot: ${JSON.stringify(repoRoot)}, entrypoint: ${JSON.stringify(entrypoint)}, outfile: ${JSON.stringify(outfile)}, bunTarget: process.argv[2], bunCommand: process.execPath, buildRunnerEntrypoint: ${JSON.stringify(join(repoRoot, 'packages/cli-common/scripts/buildServerBunBinary.mjs'))}, defines: { __HAPPIER_GUEST_CLI_CHANNEL__: JSON.stringify(process.argv[3]) } });`);
    for (const channel of ['stable', 'preview', 'publicdev']) {
      const compiled = spawnSync(process.env.HAPPIER_BUN_PATH || 'bun', [
        launcher, `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`, channel,
      ], { cwd: repoRoot, encoding: 'utf8' });
      assert.equal(compiled.status, 0, compiled.stderr);
      const result = spawnSync(outfile, [], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { source: 'public-release', channel, guestExportAvailable: false });
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
