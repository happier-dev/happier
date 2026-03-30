import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function readRepoFile(relPath) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

test('dagger expoAndroidLocalBuild does not place exported artifacts under /tmp (tmpfs)', () => {
  const src = readRepoFile('dagger/src/index.ts');

  const artifactMatch = src.match(/const\s+internalArtifact\s*=\s*`([^`]+)`/);
  assert.ok(artifactMatch, 'expected expoAndroidLocalBuild to define internalArtifact as a template string');
  const internalArtifact = artifactMatch[1];

  const outJsonMatch =
    src.match(/const\s+internalOutJson\s*=\s*`([^`]+)`/) ??
    src.match(/const\s+internalOutJson\s*=\s*"([^"]+)"/);
  assert.ok(outJsonMatch, 'expected expoAndroidLocalBuild to define internalOutJson as a string or template literal');
  const internalOutJson = outJsonMatch[1];

  assert.ok(!internalArtifact.startsWith('/tmp/'), `internalArtifact must not be under /tmp (got: ${internalArtifact})`);
  assert.ok(!internalOutJson.startsWith('/tmp/'), `internalOutJson must not be under /tmp (got: ${internalOutJson})`);
});
