import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('repo root package.json exposes repo-local hstack scripts', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const raw = await readFile(join(repoRoot, 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw);
  const scripts = pkg?.scripts ?? {};

  // Keep it minimal: assert the stable entrypoints exist and point to the wrapper.
  assert.equal(scripts.dev, 'node ./apps/stack/scripts/repo_local.mjs dev');
  assert.equal(scripts.stop, 'node ./apps/stack/scripts/repo_local.mjs stop');
  assert.equal(scripts.start, 'node ./apps/stack/scripts/repo_local.mjs start');
  assert.equal(scripts.build, 'node ./apps/stack/scripts/repo_local.mjs build');
  assert.equal(scripts.tui, 'node ./apps/stack/scripts/repo_local.mjs tui');
  assert.equal(scripts['tui:with-mobile'], 'node ./apps/stack/scripts/repo_local.mjs tui dev --mobile');
  assert.equal(scripts['cli:activate'], 'node ./apps/stack/scripts/repo_cli_activate.mjs');
  assert.equal(scripts['cli:activate:path'], 'node ./apps/stack/scripts/repo_cli_activate.mjs --install-path');
  assert.equal(scripts.auth, 'node ./apps/stack/scripts/repo_local.mjs auth');
  assert.equal(scripts.daemon, 'node ./apps/stack/scripts/repo_local.mjs daemon');
  assert.equal(scripts.eas, 'node ./apps/stack/scripts/repo_local.mjs eas');
  assert.equal(scripts.happier, 'node ./apps/stack/scripts/repo_local.mjs happier');
  assert.equal(scripts.menubar, 'node ./apps/stack/scripts/repo_local.mjs menubar');
  assert.equal(scripts.mobile, 'node ./apps/stack/scripts/repo_local.mjs mobile');
  assert.equal(scripts['mobile-dev-client'], 'node ./apps/stack/scripts/repo_local.mjs mobile-dev-client');
  assert.equal(scripts.providers, 'node ./apps/stack/scripts/repo_local.mjs providers');
  assert.equal(scripts['self-host'], 'node ./apps/stack/scripts/repo_local.mjs self-host');
  assert.equal(scripts.remote, 'node ./apps/stack/scripts/repo_local.mjs remote');
  assert.equal(scripts.setup, 'node ./apps/stack/scripts/repo_local.mjs setup');
  assert.equal(scripts.service, 'node ./apps/stack/scripts/repo_local.mjs service');
  assert.equal(scripts.logs, 'node ./apps/stack/scripts/repo_local.mjs logs --follow');
  assert.equal(scripts['logs:all'], 'node ./apps/stack/scripts/repo_local.mjs logs --follow --component=all');
  assert.equal(scripts['logs:server'], 'node ./apps/stack/scripts/repo_local.mjs logs --follow --component=server');
  assert.equal(scripts['logs:expo'], 'node ./apps/stack/scripts/repo_local.mjs logs --follow --component=expo');
  assert.equal(scripts['logs:ui'], 'node ./apps/stack/scripts/repo_local.mjs logs --follow --component=ui');
  assert.equal(scripts['logs:daemon'], 'node ./apps/stack/scripts/repo_local.mjs logs --follow --component=daemon');
  assert.equal(scripts['logs:service'], 'node ./apps/stack/scripts/repo_local.mjs logs --follow --component=service');
  assert.equal(scripts.tailscale, 'node ./apps/stack/scripts/repo_local.mjs tailscale');
  assert.equal(scripts.env, 'node ./apps/stack/scripts/repo_local.mjs env');
});
