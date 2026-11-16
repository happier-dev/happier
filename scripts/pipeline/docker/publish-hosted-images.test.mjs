import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const [channel, pushLatest] of [['preview', 'true'], ['stable', 'false']]) test(`hosted ${channel} publication retains candidate and channel tags with relay API/worker defaults`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-images-'));
  const output = path.join(dir, 'outputs');
  const sha = '0123456789abcdef0123456789abcdef01234567';
  try {
    const stdout = execFileSync(process.execPath, [
      'scripts/pipeline/docker/publish-images.mjs', '--channel', channel, '--sha', sha, '--push-latest', pushLatest,
      '--registries', 'dockerhub,ghcr', '--build-relay', 'true', '--build-dev-box', 'false',
      '--hosted-services', 'api,worker,ui', '--dry-run',
    ], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_ACTIONS: 'false' } });
    const images = JSON.parse(fs.readFileSync(output, 'utf8').trim().split('hosted_images=')[1]);
    for (const [service, target, pkg] of [
      ['api', 'relay-server', 'server'], ['worker', 'relay-server', 'server'], ['ui', 'webapp', 'ui'],
    ]) {
      const version = JSON.parse(fs.readFileSync(`apps/${pkg}/package.json`, 'utf8')).version;
      const name = service === 'ui' ? 'webapp' : 'relay-server';
      assert.equal(images[service], `ghcr.io/happier-dev/${name}:${version}-${channel}-${sha}`);
      const invocation = stdout.split('\n').find((line) => line.includes(`--target ${target} `) && line.includes(`--tag ${images[service]}`));
      assert.ok(invocation, `${service} must have a CI build`);
      assert.ok(invocation.includes(`--tag ${images[service]}`));
      assert.ok(stdout.includes(`--tag ghcr.io/happier-dev/${name}:${channel}`));
      assert.ok(stdout.includes(`--tag happierdev/${name}:${channel}`));
      if (service !== 'ui') assert.match(invocation, /HAPPIER_RELAY_SERVER_VERSION=/);
    }
    assert.equal(images.api, images.worker);
    assert.equal(stdout.split('\n').filter((line) => line.includes('--target relay-server ')).length, 2, 'one generic build per registry, shared by both roles');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the public relay image has no hosted-only variants', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  assert.doesNotMatch(dockerfile, /AS hosted-(api|worker)/);
});

for (const matchingSource of [true, false]) test(`hosted binary source ${matchingSource ? 'matches the candidate and pins its pushed digest' : 'mismatch refuses image publication'}`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-digest-'));
  const output = path.join(dir, 'outputs');
  const digest = `sha256:${'a'.repeat(64)}`;
  const sha = '0123456789abcdef0123456789abcdef01234567';
  try {
    fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
console.log('${matchingSource ? sha : 'b'.repeat(40)}');
`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'buildx' && args[1] === 'inspect') console.log('Driver: docker-container');
const index = args.indexOf('--metadata-file');
if (index >= 0) fs.writeFileSync(args[index + 1], JSON.stringify({'containerimage.digest': '${digest}'}));
`, { mode: 0o755 });
    const publish = () => execFileSync(process.execPath, ['scripts/pipeline/docker/publish-images.mjs', '--channel', 'preview',
      '--sha', sha, '--registries', 'ghcr',
      '--build-relay', 'false', '--build-dev-box', 'false', '--hosted-services', 'api'], {
      encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
        GITHUB_OUTPUT: output, GITHUB_ACTIONS: 'false', GHCR_USERNAME: 'fixture', GHCR_TOKEN: 'fixture',
        HAPPIER_DOCKER_SERVER_VERSION: '0.2.0-preview.fixture', GH_REPO: 'happier-dev/happier' },
    });
    if (!matchingSource) {
      assert.throws(publish, (error) => /artifact source does not match/.test(String(error.stderr)));
      assert.equal(fs.existsSync(output), false);
      return;
    }
    publish();
    const images = JSON.parse(fs.readFileSync(output, 'utf8').trim().split('hosted_images=')[1]);
    assert.ok(images.api.endsWith(`@${digest}`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
