import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

const repo = resolve(new URL('../../', import.meta.url).pathname);
const workflow = (name) => YAML.parse(readFileSync(join(repo, '.github/workflows', name), 'utf8'));

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'publisher-source-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=dev');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release-test@example.invalid');
  git('commit', '--allow-empty', '-m', 'old main');
  const old = git('rev-parse', 'HEAD');
  git('branch', 'main');
  git('commit', '--allow-empty', '-m', 'admitted candidate');
  const candidate = git('rev-parse', 'HEAD');
  git('branch', 'preview');
  const outside = git('commit-tree', 'HEAD^{tree}', '-p', old, '-m', 'unadmitted sibling');
  const remote = join(cwd, 'origin.git');
  git('clone', '--bare', '.', remote);
  git('remote', 'add', 'origin', remote);
  const resolver = readFileSync(join(repo, 'scripts/pipeline/github/resolve-authorized-release-source.mjs'), 'utf8');
  for (const controlRoot of [cwd, join(cwd, 'trusted-control')]) {
    const folder = join(controlRoot, 'scripts/pipeline/github');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'resolve-authorized-release-source.mjs'), resolver);
  }
  return { cwd, git, candidate, outside, old, remote };
}

for (const [product, file, job, legacy] of [
  ['npm', 'release-npm.yml', 'release', 'Verify authorized source remains canonical'],
  ['Docker', 'publish-docker.yml', 'prepare_candidate', 'Verify stable candidate is current main'],
]) {
  test(`${product} publishes an admitted preview ancestor before main moves and refuses unadmitted source`, (t) => {
    const f = fixture(t);
    const steps = workflow(file).jobs[job].steps;
    const guard = steps.find((step) => step.name === 'Verify admitted publication source')
      ?? steps.find((step) => step.name === legacy || step.name === 'Guard stable channel');
    assert.ok(guard, 'publication source must be verified before publishing');
    const preparation = product === 'Docker' ? steps.find((step) => step.name === 'Freeze and verify candidate source SHA').run : '';
    const run = (authorized = f.candidate, branch = 'preview', channel = product === 'npm' ? 'production' : 'stable', cwd = f.cwd) => spawnSync('bash', ['-c', `${preparation}\n${guard.run}`], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_WORKSPACE: f.cwd, GITHUB_OUTPUT: join(f.cwd, 'github-output'), AUTHORIZED_SHA: authorized, SOURCE_SHA: f.git('rev-parse', 'HEAD'), CANONICAL_REF: 'main', PROMOTION_SOURCE_REF: branch, CHANNEL: channel, RESOLVED_SOURCE_REF: f.candidate },
    });
    assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], f.old);
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    const shallow = join(f.cwd, 'shallow');
    f.git('clone', '--depth=1', '--branch=preview', `file://${f.remote}`, shallow);
    // A later source commit must not invalidate the admitted exact candidate.
    const advanced = f.git('commit-tree', 'HEAD^{tree}', '-p', f.candidate, '-m', 'source advanced');
    f.git('--git-dir', f.remote, 'fetch', f.cwd, advanced);
    f.git('--git-dir', f.remote, 'update-ref', 'refs/heads/preview', advanced);
    result = run();
    assert.equal(result.status, 0, result.stderr);
    result = run(f.candidate, 'preview', undefined, shallow);
    assert.equal(result.status, 0, `shallow candidate ancestry: ${result.stderr}`);
    result = run('', 'preview');
    assert.notEqual(result.status, 0, 'G3 publication requires an admitted SHA');
    result = run(f.outside);
    assert.notEqual(result.status, 0, 'a different checkout must not impersonate admission');
    f.git('update-ref', 'HEAD', f.outside);
    result = run(f.outside);
    assert.notEqual(result.status, 0, 'an existing SHA outside the admitted branch must refuse');
    f.git('update-ref', 'HEAD', f.candidate);
    assert.equal(run(f.candidate, 'dev', product === 'npm' ? 'preview' : 'preview').status, 0, 'preview G3 uses dev');
    assert.equal(run(f.candidate, 'dev').status, 0, 'direct dev-to-production retains its admitted source');
    assert.notEqual(run(f.candidate, 'unreviewed').status, 0, 'a missing promotion branch must refuse');
    assert.notEqual(run(f.candidate, '').status, 0, 'standalone publication still requires current channel identity');
    f.git('--git-dir', f.remote, 'update-ref', 'refs/heads/main', f.candidate);
    assert.equal(run(f.candidate, '').status, 0, 'standalone publication accepts current main');
  });
}

test('release publishers consume the preflight promotion source instead of re-deciding the branch', () => {
  const jobs = workflow('release-channel.yml').jobs;
  for (const name of ['publish_npm', 'publish_docker']) {
    const publisher = workflow(name === 'publish_npm' ? 'release-npm.yml' : 'publish-docker.yml');
    assert.equal(publisher.on.workflow_dispatch?.inputs?.promotion_source_ref, undefined, 'standalone dispatch cannot forge preflight admission');
    assert.equal(publisher.on.workflow_call.inputs.promotion_source_ref.default, '');
    assert.ok(jobs[name].needs.includes('release_preflight'), `${name} needs its authority producer`);
    assert.equal(jobs[name].with.promotion_source_ref, '${{ needs.release_preflight.outputs.source_ref }}');
  }
});
