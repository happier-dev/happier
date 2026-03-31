import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getPublicServerUrlEnvOverride, resolveServerUrls } from './urls.mjs';

test('getPublicServerUrlEnvOverride prefers HAPPIER_PUBLIC_SERVER_URL over HAPPIER_STACK_SERVER_URL when both are stack-local', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-server-urls-'));
  const envPath = join(dir, 'stack.env');
  await writeFile(
    envPath,
    [
      'HAPPIER_PUBLIC_SERVER_URL=https://public.stack.example.test',
      'HAPPIER_STACK_SERVER_URL=http://127.0.0.1:3005',
    ].join('\n'),
    'utf-8'
  );

  const out = getPublicServerUrlEnvOverride({
    env: {
      HAPPIER_STACK_STACK: 'dev-built',
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_PUBLIC_SERVER_URL: 'https://public.stack.example.test',
      HAPPIER_STACK_SERVER_URL: 'http://127.0.0.1:3005',
    },
    serverPort: 3005,
  });

  assert.equal(out.envPublicUrl, 'https://public.stack.example.test');
  assert.equal(out.publicServerUrl, 'https://public.stack.example.test');
});

test('getPublicServerUrlEnvOverride falls back to HAPPIER_STACK_SERVER_URL when no public URL is set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-server-urls-'));
  const envPath = join(dir, 'stack.env');
  await writeFile(envPath, 'HAPPIER_STACK_SERVER_URL=https://stack-share.example.test\n', 'utf-8');

  const out = getPublicServerUrlEnvOverride({
    env: {
      HAPPIER_STACK_STACK: 'dev-built',
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_SERVER_URL: 'https://stack-share.example.test',
    },
    serverPort: 3005,
  });

  assert.equal(out.envPublicUrl, 'https://stack-share.example.test');
  assert.equal(out.publicServerUrl, 'https://stack-share.example.test');
});

test('resolveServerUrls prefers the canonical relay access url from persisted cloudflare named-tunnel config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-server-urls-relay-'));
  const homeDir = join(dir, 'home');
  const envPath = join(dir, 'stack.env');
  await mkdir(join(homeDir, '.happier', 'relay', 'access'), { recursive: true });
  await writeFile(
    join(homeDir, '.happier', 'relay', 'access', 'local.json'),
    JSON.stringify({ providerId: 'cloudflareNamed', hostname: 'relay.example.test', token: 'secret' }),
    'utf-8'
  );
  await writeFile(envPath, 'HAPPIER_STACK_SERVER_URL=http://127.0.0.1:3005\n', 'utf-8');

  try {
    const out = await resolveServerUrls({
      env: {
        HOME: homeDir,
        HAPPIER_STACK_STACK: 'dev-built',
        HAPPIER_STACK_ENV_FILE: envPath,
        // Real stacks typically inherit the stack.env values into env via withStackEnv.
        // Ensure relay-access canonical URL still wins over a localhost/default stack URL.
        HAPPIER_STACK_SERVER_URL: 'http://127.0.0.1:3005',
        HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '0',
        HAPPIER_STACK_TAILSCALE_SERVE: '0',
      },
      serverPort: 3005,
      allowEnable: false,
    });

    assert.equal(out.publicServerUrl, 'https://relay.example.test');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
