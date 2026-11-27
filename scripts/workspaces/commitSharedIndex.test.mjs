import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { syncPublishedIndex } from './commitSharedIndex.mjs';

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'happier-index-publication-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('commit', '--allow-empty', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'new'), 'new\n');
  git('add', 'new');
  git('commit', '-qm', 'tip');
  const commit = git('rev-parse', 'HEAD');
  git('read-tree', base);
  return { root, repo, base, commit, git };
}

async function startPausedPublisher(t, { root, repo, base, commit }) {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const marker = join(root, 'preparer.pid');
  const fixtureGit = join(bin, 'git');
  writeFileSync(fixtureGit, `#!/bin/sh
case " $* " in
  *" update-index "*)
    if [ ! -e "$INDEX_FIXTURE_PID" ]; then
      printf '%s\\n' "$$" > "$INDEX_FIXTURE_PID"
      read -r _ < "$INDEX_FIXTURE_PIPE"
    fi
    ;;
esac
exec "$REAL_GIT" "$@"
`, { mode: 0o755 });
  const pipe = join(root, 'gate');
  execFileSync('mkfifo', [pipe]);
  const moduleUrl = new URL('./commitSharedIndex.mjs', import.meta.url);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { syncPublishedIndex } from ${JSON.stringify(moduleUrl.href)};
    await syncPublishedIndex(${JSON.stringify({ repo, base, commit })});`], {
    cwd: repo, env: { ...process.env, PATH: bin + delimiter + process.env.PATH, REAL_GIT: realGit,
      INDEX_FIXTURE_PID: marker, INDEX_FIXTURE_PIPE: pipe },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  t.after(() => {
    child.kill('SIGKILL');
    if (existsSync(marker)) {
      try { process.kill(Number(readFileSync(marker, 'utf8')), 'SIGKILL'); } catch {}
    }
  });
  const exited = once(child, 'exit');
  while (!existsSync(marker) || !readFileSync(marker, 'utf8').trim()) {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(child.exitCode, null, 'publisher exited before index preparation');
  }
  return { child, exited, resume: () => writeFile(pipe, 'continue\n') };
}

test('a killed index preparer leaves the shared index available to Git', {
  skip: process.platform === 'win32', timeout: 15_000,
}, async t => {
  const fixture = repository(t);
  const { child, exited } = await startPausedPublisher(t, fixture);
  child.kill('SIGKILL');
  await exited;
  assert.equal(existsSync(join(fixture.repo, '.git', 'index.lock')), false);
  fixture.git('add', 'new');
});

test('staging that arrives during private preparation survives publication', {
  skip: process.platform === 'win32', timeout: 15_000,
}, async t => {
  const fixture = repository(t);
  const { repo, git } = fixture;
  const { exited, resume } = await startPausedPublisher(t, fixture);
  writeFileSync(join(repo, 'foreign'), 'concurrent staging\n');
  git('add', 'foreign');
  await resume();
  assert.deepEqual(await exited, [0, null]);
  assert.equal(git('show', ':foreign'), 'concurrent staging');
  assert.equal(git('show', ':new'), 'new');
});

test('genuinely staged changes survive index publication', async t => {
  const { repo, base, commit, git } = repository(t);
  writeFileSync(join(repo, 'new'), 'staged version\n');
  git('add', 'new');
  assert.equal(await syncPublishedIndex({ repo, base, commit }), 0);
  assert.equal(git('show', ':new'), 'staged version');
});
