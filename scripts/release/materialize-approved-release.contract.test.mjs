import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(repo, 'scripts/pipeline/release/materialize-approved-release.mjs');
const releaseId = '2026-11-01.1';
const notes = `# Changelog\n\n## Release ${releaseId} - 2026-11-01\n\n<!-- happier-release-note-projections:v1\n{"expo":{"message":"Approved update"}}\n-->\n\nCLI and server changes approved together.\n`;

function fixture(target = 'preview', confirm = 'release dev to preview', { paddingFiles = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'approved-release-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: Infinity }).trim();
  const put = (name, value) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), value); };
  git('init', '-q');
  git('config', 'user.name', 'Fixture Machine');
  git('config', 'user.email', 'fixture@example.invalid');
  for (const name of ['apps/ui', 'apps/cli', 'apps/server', 'packages/relay-server']) put(`${name}/package.json`, '{"name":"fixture","version":"1.0.0"}\n');
  put('apps/ui/app.config.js', 'export default { expo: { version: "1.0.0", name: "fixture" } };\n');
  put('apps/ui/src-tauri/tauri.conf.json', '{"version":"1.0.0","identifier":"fixture"}\n');
  put('apps/ui/CHANGELOG.md', '# Changelog\n');
  put('unrelated.txt', 'base\n');
  // Real checkouts list far more tracked paths than Node's default child-output buffer holds.
  for (let i = 0; i < paddingFiles; i += 1) put(`pad/${'d'.repeat(200)}/${'e'.repeat(200)}/${i}.txt`, '');
  git('add', '--', '.'); git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  const bin = join(root, 'boundary-bin'); mkdirSync(bin);
  // Only the producer's remote Git boundary is replaced; the materializer uses real Git.
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$1" in\nstatus|diff|fetch|cat-file|merge-base) exit 0;;\nls-remote) printf '${baseSha}\\t%s\\n' "$3";;\nrev-parse) printf '${baseSha}\\n';;\n*) exit 2;;\nesac\n`, { mode: 0o755 });
  const produced = spawnSync(process.execPath, [join(repo, 'scripts/pipeline/run.mjs'), 'release', '--confirm', confirm, '--repository', 'happier-dev/happier', '--deploy-environment', target, '--deploy-targets', 'cli,server', '--source-sha', baseSha, '--operation-id', 'rel_packet_fixture', '--release-notes-id', releaseId, '--allow-dirty', 'true', '--dry-run', '--json'], { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(produced.status, 0, produced.stderr);
  const intent = JSON.parse(produced.stdout);
  const packet = { kind: 'happier.approved-release-packet.v1', baseSha, releaseId, notes: { content: notes }, versions: { cli: '2.3.4', server: '3.2.1' }, intent };
  const invoke = (input = packet, env = process.env) => {
    put('packet.json', JSON.stringify(input));
    return spawnSync(process.execPath, [script, '--packet', join(root, 'packet.json'), '--json'], { cwd: root, env, encoding: 'utf8' });
  };
  return { root, git, put, baseSha, packet, invoke, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('approved packet materializes exact notes and lockstep versions, preserving foreign work/index and reusing its direct child', () => {
  const f = fixture();
  try {
    f.put('unrelated.txt', 'staged\n'); f.git('add', '--', 'unrelated.txt'); f.put('unrelated.txt', 'unstaged\n');
    const index = f.git('diff', '--cached', '--binary');
    const first = f.invoke(); assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.kind, 'happier.materialized-release.v1');
    assert.equal(result.baseSha, f.baseSha); assert.equal(result.target, 'preview');
    assert.equal(result.sourceBranch, f.packet.intent.sourceBranch); assert.equal(result.releaseId, releaseId);
    assert.equal(f.git('rev-parse', 'HEAD^'), f.baseSha);
    assert.equal(f.git('rev-parse', 'HEAD'), result.sourceSha);
    const expected = structuredClone(f.packet.intent);
    expected.authorizedPromotionSourceSha = result.sourceSha;
    expected.hostedDispatch.inputs.authorized_promotion_source_sha = result.sourceSha;
    assert.deepEqual(result.intent, expected);
    assert.equal(f.git('show', 'HEAD:apps/ui/CHANGELOG.md'), notes.trim());
    for (const p of ['apps/server/package.json', 'packages/relay-server/package.json']) assert.equal(JSON.parse(f.git('show', `HEAD:${p}`)).version, '3.2.1');
    assert.equal(JSON.parse(f.git('show', 'HEAD:apps/cli/package.json')).version, '2.3.4');
    assert.equal(f.git('diff', '--cached', '--binary'), index);
    assert.equal(readFileSync(join(f.root, 'unrelated.txt'), 'utf8'), 'unstaged\n');
    assert.equal(f.git('show', 'HEAD:unrelated.txt'), 'base');
    assert.equal(f.git('config', 'user.name'), 'Fixture Machine');
    const retry = f.invoke(); assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(JSON.parse(retry.stdout), result);
  } finally { f.close(); }
});

test('approved packet materializes in a repository whose tracked path listing exceeds 1 MiB', () => {
  const f = fixture('preview', 'release dev to preview', { paddingFiles: 3000 });
  try {
    assert.ok(f.git('ls-tree', '-r', '--name-only', '-z', f.baseSha).length > 1024 * 1024);
    const result = f.invoke(); assert.equal(result.status, 0, result.stderr);
    assert.equal(f.git('rev-parse', 'HEAD^'), f.baseSha);
    assert.equal(JSON.parse(f.git('show', 'HEAD:apps/cli/package.json')).version, '2.3.4');
  } finally { f.close(); }
});

for (const [name, mutate] of [
  ['wrong base', (p) => { p.baseSha = 'a'.repeat(40); }],
  ['noninitial attempt', (p) => { p.intent.hostedDispatch.inputs.hmaint_attempt_id = 'attempt_2'; }],
  ['missing initial attempt', (p) => { delete p.intent.hostedDispatch.inputs.hmaint_attempt_id; }],
  ['top-level resume grant', (p) => { p.intent.resumeRunId = '123'; }],
  ['hosted resume grant', (p) => { p.intent.hostedDispatch.inputs.resume_run_id = '123'; }],
  ['cross-packet source', (p) => { p.intent.hostedDispatch.inputs.authorized_promotion_source_sha = 'a'.repeat(40); }],
  ['cross-packet notes', (p) => { p.intent.releaseNotesId = 'other'; }],
  ['wrong source branch', (p) => { p.intent.sourceBranch = 'foreign'; }],
  ['invalid target', (p) => { p.intent.hostedDispatch.inputs.environment = 'dev'; }],
  ['invalid notes', (p) => { p.notes.content = '# No approved release'; }],
  ['invalid exact version', (p) => { p.versions.cli = '2.03.4'; }],
  ['unknown component', (p) => { p.versions.unknown = '1.2.3'; }],
]) test(`approved packet refuses ${name} before any source writes`, () => {
  const f = fixture();
  try {
    mutate(f.packet); const before = f.git('status', '--porcelain', '--untracked-files=no');
    const result = f.invoke(); assert.notEqual(result.status, 0);
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseSha);
    assert.equal(f.git('status', '--porcelain', '--untracked-files=no'), before);
  } finally { f.close(); }
});

for (const staged of [false, true]) test(`approved path ${staged ? 'index' : 'worktree'} conflict is refused without overwriting`, () => {
  const f = fixture();
  try {
    f.put('apps/cli/package.json', '{"version":"9.9.9"}\n');
    if (staged) { f.git('add', '--', 'apps/cli/package.json'); f.put('apps/cli/package.json', '{"name":"fixture","version":"1.0.0"}\n'); }
    const before = f.git('diff', '--cached', '--binary');
    const result = f.invoke(); assert.notEqual(result.status, 0);
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseSha);
    assert.equal(f.git('diff', '--cached', '--binary'), before);
    assert.equal(readFileSync(join(f.root, 'apps/ui/CHANGELOG.md'), 'utf8'), '# Changelog\n');
  } finally { f.close(); }
});

test('exact version CLI does not silently ignore a conflicting bump or malformed version', () => {
  const f = fixture();
  try {
    const bump = join(repo, 'scripts/pipeline/release/bump-version.mjs');
    for (const args of [['--version', '2.3.4', '--bump', 'patch'], ['--version', '1.02.3'], ['--version', '2.3.4', '--typo', 'x']]) {
      const result = spawnSync(process.execPath, [bump, '--component', 'cli', ...args], { cwd: f.root, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.equal(JSON.parse(readFileSync(join(f.root, 'apps/cli/package.json'), 'utf8')).version, '1.0.0');
    }
    const result = spawnSync(process.execPath, [bump, '--component', 'cli', '--version', '2.3.4'], { cwd: f.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(f.root, 'apps/cli/package.json'), 'utf8')).version, '2.3.4');
  } finally { f.close(); }
});

for (const committed of [false, true]) test(`packet refuses unrelated package content ${committed ? 'in a direct child' : 'already at its approved version'}`, () => {
  const f = fixture();
  try {
    if (committed) {
      const first = f.invoke(); assert.equal(first.status, 0, first.stderr);
      // Amend in this disposable fixture only: retain the approved base parent.
      const pkg = JSON.parse(readFileSync(join(f.root, 'apps/cli/package.json'), 'utf8'));
      f.put('apps/cli/package.json', `${JSON.stringify({ ...pkg, dependencies: { unauthorized: '*' } }, null, 2)}\n`);
      f.git('add', '--', 'apps/cli/package.json'); f.git('commit', '--amend', '--no-edit', '-q');
    } else {
      f.put('apps/cli/package.json', `${JSON.stringify({ name: 'fixture', version: '2.3.4', dependencies: { unauthorized: '*' } }, null, 2)}\n`);
    }
    const head = f.git('rev-parse', 'HEAD');
    const before = f.git('diff', '--binary');
    const result = f.invoke(); assert.notEqual(result.status, 0);
    assert.equal(f.git('rev-parse', 'HEAD'), head);
    assert.equal(f.git('diff', '--binary'), before);
  } finally { f.close(); }
});

for (const sharedRef of [true, false]) test(`materialization ${sharedRef ? 'rebinds shared' : 'preserves distinct'} workflow control source`, () => {
  const f = sharedRef ? fixture() : fixture('production', 'release dev to main');
  try {
    const controlSha = sharedRef ? f.baseSha : 'b'.repeat(40);
    f.packet.intent.hostedDispatch.inputs.workflow_control_sha = controlSha;
    const result = f.invoke(); assert.equal(result.status, 0, result.stderr);
    const materialized = JSON.parse(result.stdout);
    assert.equal(materialized.intent.hostedDispatch.inputs.workflow_control_sha, sharedRef ? materialized.sourceSha : controlSha);
  } finally { f.close(); }
});

test('approved packet refuses preview-source production without source or commit effects', () => {
  const f = fixture('production', 'release preview to main');
  try {
    f.put('unrelated.txt', 'staged\n'); f.git('add', '--', 'unrelated.txt'); f.put('unrelated.txt', 'unstaged\n');
    const before = {
      head: f.git('rev-parse', 'HEAD'),
      source: f.git('diff', '--binary'),
      index: f.git('diff', '--cached', '--binary'),
      status: f.git('status', '--porcelain', '--untracked-files=no'),
    };
    const result = f.invoke();
    assert.equal(result.status, 1, 'preview production must consume its validated candidate without materialization');
    assert.match(result.stderr, /preview.*materializ|materializ.*preview/i);
    assert.equal(result.stdout, '');
    assert.deepEqual({
      head: f.git('rev-parse', 'HEAD'),
      source: f.git('diff', '--binary'),
      index: f.git('diff', '--cached', '--binary'),
      status: f.git('status', '--porcelain', '--untracked-files=no'),
    }, before, 'refusal preserves source bytes, foreign work/index and the existing commit');
  } finally { f.close(); }
});

test('a failed local commit leaves approved content visible and the same packet can finish without a second bump', () => {
  const f = fixture();
  try {
    const failed = f.invoke(f.packet, { ...process.env, GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '' });
    assert.notEqual(failed.status, 0);
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseSha);
    assert.equal(readFileSync(join(f.root, 'apps/ui/CHANGELOG.md'), 'utf8'), notes);
    const retry = f.invoke(); assert.equal(retry.status, 0, retry.stderr);
    assert.equal(f.git('rev-parse', 'HEAD^'), f.baseSha);
    assert.equal(JSON.parse(f.git('show', 'HEAD:apps/cli/package.json')).version, '2.3.4');
  } finally { f.close(); }
});

test('approved UI version uses the existing package, Expo and Tauri writer in lockstep', () => {
  const f = fixture();
  try {
    f.packet.versions.app = '4.5.6';
    const result = f.invoke(); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(f.git('show', 'HEAD:apps/ui/package.json')).version, '4.5.6');
    assert.match(f.git('show', 'HEAD:apps/ui/app.config.js'), /version: "4\.5\.6", name: "fixture"/);
    assert.deepEqual(JSON.parse(f.git('show', 'HEAD:apps/ui/src-tauri/tauri.conf.json')), { version: '4.5.6', identifier: 'fixture' });
  } finally { f.close(); }
});

for (const [file, content] of [
  ['apps/ui/app.config.js', 'export default { expo: { version: "4.5.6", name: "unapproved" } };\n'],
  ['apps/ui/src-tauri/tauri.conf.json', '{"version":"4.5.6","identifier":"unapproved"}\n'],
]) test(`packet refuses non-version changes in ${file}`, () => {
  const f = fixture();
  try {
    f.packet.versions.app = '4.5.6'; f.put(file, content);
    const result = f.invoke(); assert.notEqual(result.status, 0);
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseSha);
    assert.equal(readFileSync(join(f.root, file), 'utf8'), content);
  } finally { f.close(); }
});
