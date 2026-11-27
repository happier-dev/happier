import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const controlRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// A resumed release builds an older candidate source with newer workflow control. The candidate is inert build
// context; the trusted control checkout owns how it is built (2026-11-26: the candidate Dockerfile predated the
// ONNX Runtime CUDA-download fix and could no longer build).
test('images build the candidate context with the workflow-control Dockerfiles', () => {
  const candidate = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-candidate-'));
  try {
    fs.copyFileSync(path.join(controlRoot, 'package.json'), path.join(candidate, 'package.json'));
    for (const pkg of ['ui', 'server', 'cli']) {
      fs.mkdirSync(path.join(candidate, 'apps', pkg), { recursive: true });
      fs.copyFileSync(path.join(controlRoot, 'apps', pkg, 'package.json'), path.join(candidate, 'apps', pkg, 'package.json'));
    }
    const stdout = execFileSync(process.execPath, [
      path.join(controlRoot, 'scripts/pipeline/docker/publish-images.mjs'), '--channel', 'stable',
      '--sha', '0123456789abcdef0123456789abcdef01234567', '--push-latest', 'false', '--registries', 'ghcr',
      '--build-relay', 'true', '--build-dev-box', 'true', '--hosted-services', 'api,ui', '--dry-run',
    ], { cwd: candidate, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: path.join(candidate, 'out'), GITHUB_ACTIONS: 'false' } });
    const builds = stdout.split('\n').filter((line) => line.includes('buildx build'));
    assert.ok(builds.length >= 3, 'relay, dev-box and hosted builds are planned');
    for (const line of builds) {
      const file = line.match(/--file (\S+)/)?.[1];
      assert.ok(file && path.isAbsolute(file) && file.startsWith(`${controlRoot}${path.sep}`), `control Dockerfile expected: ${line}`);
      assert.match(line, / \.$/, 'the candidate checkout stays the build context');
    }
  } finally {
    fs.rmSync(candidate, { recursive: true, force: true });
  }
});
