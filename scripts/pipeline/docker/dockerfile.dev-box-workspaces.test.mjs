import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('dev-box Dockerfile consumes the CLI release artifact without stack/source workspaces', () => {
  const repoRoot = process.cwd();
  const dockerfilePath = path.join(repoRoot, 'docker', 'dev-box', 'Dockerfile');
  const raw = fs.readFileSync(dockerfilePath, 'utf8');

  assert.match(raw, /FROM debian:12-slim AS devbox-artifacts/);
  assert.match(raw, /fetch-verified-release-artifact/);
  assert.match(raw, /HAPPIER_DEVBOX_CLI_RELEASE_TAG/);
  assert.match(raw, /HAPPIER_DEVBOX_CLI_VERSION/);
  assert.match(raw, /--product happier/);
  assert.match(raw, /--dest \/opt\/happier\/cli/);
  assert.match(raw, /FROM debian:12-slim AS devbox/);
  assert.match(raw, /COPY --from=devbox-artifacts --chown=happier:happier \/opt\/happier\/cli \/opt\/happier\/cli/);
  assert.match(raw, /ln -sf \/opt\/happier\/cli\/happier \/usr\/local\/bin\/happier/);

  assert.doesNotMatch(raw, /AS cli-builder/);
  assert.doesNotMatch(raw, /COPY apps\/stack/);
  assert.doesNotMatch(raw, /ln -sf .*hstack/);
  assert.doesNotMatch(raw, /COPY --from=cli-builder \/repo\/node_modules/);
  assert.doesNotMatch(raw, /yarn-install-with-retry --frozen-lockfile/);
});

test('dev-box keeps a non-root runtime user and writable Happier home', () => {
  const repoRoot = process.cwd();
  const dockerfilePath = path.join(repoRoot, 'docker', 'dev-box', 'Dockerfile');
  const raw = fs.readFileSync(dockerfilePath, 'utf8');

  assert.match(raw, /useradd -m -s \/bin\/bash happier/);
  assert.match(raw, /mkdir -p \/opt\/happier\/cli \/home\/happier\/\.local\/bin \/home\/happier\/\.npm-global \/workspace/);
  assert.match(raw, /chown -R happier:happier \/home\/happier \/opt\/happier \/workspace/);
  assert.match(raw, /ENV NPM_CONFIG_PREFIX=\/home\/happier\/\.npm-global/);
  assert.match(raw, /ENV PATH=\/opt\/happier\/cli:\/home\/happier\/\.local\/bin:\/home\/happier\/\.npm-global\/bin:\$PATH/);
  assert.match(raw, /\bUSER happier\b/);
  assert.match(raw, /WORKDIR \/workspace/);
});

test('dev-box Docker build context includes its entrypoint script', () => {
  const repoRoot = process.cwd();
  const dockerignorePath = path.join(repoRoot, '.dockerignore');
  const raw = fs.readFileSync(dockerignorePath, 'utf8');

  assert.match(raw, /^!docker$/m);
  assert.match(raw, /^!docker\/dev-box$/m);
  assert.match(raw, /^!docker\/dev-box\/\*\*$/m);
});
