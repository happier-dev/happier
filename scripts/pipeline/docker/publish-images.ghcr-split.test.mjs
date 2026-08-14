import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

function run(cmd, args, opts) {
  return execFileSync(cmd, args, {
    cwd: opts?.cwd ?? process.cwd(),
    env: opts?.env ?? process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('docker publish splits buildx pushes by registry when pushing to dockerhub + ghcr', () => {
  const repoRoot = process.cwd();
  const scriptPath = path.join(repoRoot, 'scripts/pipeline/docker/publish-images.mjs');

  const out = run(process.execPath, [scriptPath, '--channel', 'dev', '--registries', 'dockerhub,ghcr', '--dry-run'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GITHUB_ACTIONS: 'false',
      GHCR_NAMESPACE: 'ghcr.io/happier-dev',
    },
  });

  assert.match(out, /--tag\s+happierdev\/relay-server:dev\b/);
  assert.match(out, /--tag\s+ghcr\.io\/happier-dev\/relay-server:dev\b/);

  const relayBuildInvocations = out.match(/docker buildx build[\s\S]*?--target\s+relay-server/g) ?? [];
  assert.ok(
    relayBuildInvocations.length >= 2,
    `expected >=2 relay-server buildx invocations (one per registry), got ${relayBuildInvocations.length}\n${out}`,
  );
});

test('docker publish fails when a selected registry push fails', () => {
  const repoRoot = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-docker-registry-required-'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const callsPath = path.join(tmpDir, 'docker-calls.jsonl');
  const dockerPath = path.join(binDir, 'docker');
  fs.writeFileSync(
    dockerPath,
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_STUB_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'buildx' && args[1] === 'build' && args.includes('--tag') && args.some((arg) => arg.startsWith('ghcr.io/'))) {
  process.stderr.write('simulated GHCR push failure\\n');
  process.exit(17);
}
if (args[0] === 'buildx' && args[1] === 'inspect') process.stdout.write('Driver: docker-container\\n');
`,
    { encoding: 'utf8', mode: 0o755 },
  );

  let error;
  try {
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts/pipeline/docker/publish-images.mjs'),
        '--channel',
        'dev',
        '--registries',
        'dockerhub,ghcr',
        '--build-relay',
        'true',
        '--build-dev-box',
        'false',
        '--push-latest',
        'false',
        '--sha',
        '0123456789abcdef0123456789abcdef01234567',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          DOCKER_STUB_CALLS: callsPath,
          DOCKERHUB_USERNAME: 'docker-user',
          DOCKERHUB_TOKEN: 'docker-token',
          GHCR_USERNAME: 'gh-user',
          GHCR_TOKEN: 'gh-token',
          HAPPIER_DOCKER_SERVER_VERSION: '0.2.10-test',
          GITHUB_ACTIONS: 'false',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );
  } catch (caught) {
    error = caught;
  }

  assert.notEqual(error, undefined, 'GHCR failure must fail the selected-registry publication');
  const calls = fs
    .readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(calls.some((args) => args.includes('happierdev/relay-server:dev')), 'Docker Hub push should run first');
  assert.ok(calls.some((args) => args.includes('ghcr.io/happier-dev/relay-server:dev')), 'GHCR push should run');
});
