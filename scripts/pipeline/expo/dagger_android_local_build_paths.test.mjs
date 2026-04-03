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

test('dagger expoAndroidLocalBuild clears the EAS local workingdir between runs', () => {
  const src = readRepoFile('dagger/src/index.ts');

  // The Android local build uses a Dagger cache volume mounted under /tmp for scratch space.
  // Cache volumes persist across runs, but the EAS local build plugin requires the *working dir*
  // itself to be empty. For robustness, we must point EAS at a subdirectory under the cache mount
  // (not the cache root), so previous build residues cannot block the next build.
  assert.ok(
    !/withEnvVariable\(\s*["']EAS_LOCAL_BUILD_WORKINGDIR["']\s*,\s*["']\/tmp\/eas-workdir["']\s*\)/.test(src),
    'expected expoAndroidLocalBuild to avoid using /tmp/eas-workdir as the exact EAS_LOCAL_BUILD_WORKINGDIR value',
  );
  assert.match(src, /const\s+easWorkdirRoot\s*=\s*["']\/tmp\/eas-workdir["']/, 'expected easWorkdirRoot to be /tmp/eas-workdir');
  assert.match(
    src,
    /const\s+easWorkdir\s*=\s*`[^`]*\$\{easWorkdirRoot\}\/[^`]+`/,
    'expected easWorkdir to be a template string under easWorkdirRoot (subdirectory)',
  );
  assert.match(
    src,
    /withEnvVariable\(\s*["']EAS_LOCAL_BUILD_WORKINGDIR["']\s*,\s*easWorkdir\s*\)/,
    'expected expoAndroidLocalBuild to set EAS_LOCAL_BUILD_WORKINGDIR from easWorkdir',
  );
});
