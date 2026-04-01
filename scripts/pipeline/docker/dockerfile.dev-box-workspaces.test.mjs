import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('dev-box Dockerfile includes CLI workspace deps (avoid fetching internal @happier-dev/* from npm)', () => {
  const repoRoot = process.cwd();
  const dockerfilePath = path.join(repoRoot, 'docker', 'dev-box', 'Dockerfile');
  const raw = fs.readFileSync(dockerfilePath, 'utf8');

  // The CLI depends on these internal workspaces. If they are not present in the build context during
  // `yarn install`, Yarn will try to fetch them from the public npm registry and fail.
  for (const pkg of ['packages/connection-supervisor', 'packages/transfers']) {
    assert.ok(raw.includes(pkg), `expected Dockerfile to reference ${pkg}`);
    assert.ok(raw.includes(`COPY ${pkg}/package.json ${pkg}/`), `expected package.json COPY for ${pkg}`);
    assert.ok(raw.includes(`COPY ${pkg} ./${pkg}`), `expected source COPY for ${pkg}`);
  }
});
