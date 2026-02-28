import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const prepareScript = join(here, 'prepare-local-monorepo.mjs');

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    throw new Error(
      [
        `Command failed: ${cmd} ${args.join(' ')}`,
        `cwd: ${opts?.cwd ?? process.cwd()}`,
        `status: ${res.status}`,
        res.stderr || res.stdout || '',
      ].join('\n'),
    );
  }
  return res;
}

test('prepare-local-monorepo commits applied diffs so downstream clones include them', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'happier-prepare-local-monorepo-'));
  const src = join(tmp, 'src');
  const dst = join(tmp, 'dst');
  const clone = join(tmp, 'clone');

  fs.mkdirSync(src, { recursive: true });
  run('git', ['init', '-q'], { cwd: src });

  fs.writeFileSync(join(src, 'a.txt'), 'one\n', 'utf8');
  run('git', ['add', 'a.txt'], { cwd: src });
  run('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init', '-q'], { cwd: src });

  // Add an ignore rule (ignored files should not be copied).
  fs.writeFileSync(join(src, '.gitignore'), 'ignored.txt\n', 'utf8');
  run('git', ['add', '.gitignore'], { cwd: src });
  run('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'ignore', '-q'], { cwd: src });

  // Unstaged working-tree diff (should be applied).
  fs.writeFileSync(join(src, 'a.txt'), 'two\n', 'utf8');

  // Staged diff (should be applied).
  fs.writeFileSync(join(src, 'b.txt'), 'staged\n', 'utf8');
  run('git', ['add', 'b.txt'], { cwd: src });

  // Untracked file (copied so local checkouts behave like a full snapshot).
  fs.writeFileSync(join(src, 'c.txt'), 'untracked\n', 'utf8');

  // Ignored file (not copied).
  fs.writeFileSync(join(src, 'ignored.txt'), 'ignored\n', 'utf8');

  const res = spawnSync(process.execPath, [prepareScript, '--src', src, '--dst', dst], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const refRes = spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/main'], { cwd: dst });
  assert.equal(refRes.status, 0);

  const status = spawnSync('git', ['status', '--porcelain=v1'], { cwd: dst, encoding: 'utf8' });
  assert.equal(status.status, 0);
  assert.equal((status.stdout ?? '').trim(), '');

  run('git', ['clone', '--quiet', dst, clone], { cwd: tmp });
  assert.equal(fs.readFileSync(join(clone, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(fs.readFileSync(join(clone, 'b.txt'), 'utf8'), 'staged\n');
  assert.equal(fs.readFileSync(join(clone, 'c.txt'), 'utf8'), 'untracked\n');
  assert.equal(fs.existsSync(join(clone, 'ignored.txt')), false);
});
