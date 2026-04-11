import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

import { getPublicServerUrlEnvOverride, getWebappUrlEnvOverride, resolveServerUrls } from './urls.mjs';

async function createIsolatedStackStorage(t) {
  const storageDir = await mkdtemp(join(tmpdir(), 'hstack-server-urls-storage-'));
  t.after(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });
  return {
    storageDir,
    stackName: `stack-${basename(storageDir)}`,
  };
}

async function writeStackEnvAtStorageRoot(storageDir, stackName, contents) {
  const stackDir = join(storageDir, stackName);
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'env'), contents, 'utf-8');
}

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

test('getPublicServerUrlEnvOverride expands ~/ explicit env file overrides against HOME', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-server-urls-'));
  const homeDir = join(dir, 'home');
  const envPath = join(homeDir, '.happier', 'stacks', 'dev', 'env');
  await mkdir(join(homeDir, '.happier', 'stacks', 'dev'), { recursive: true });
  await writeFile(envPath, 'HAPPIER_STACK_SERVER_URL=https://stack-share.example.test\n', 'utf-8');

  const out = getPublicServerUrlEnvOverride({
    env: {
      HOME: homeDir,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_ENV_FILE: '~/.happier/stacks/dev/env',
      HAPPIER_STACK_SERVER_URL: 'https://stack-share.example.test',
    },
    serverPort: 3005,
  });

  assert.equal(out.envPublicUrl, 'https://stack-share.example.test');
  assert.equal(out.publicServerUrl, 'https://stack-share.example.test');
});

test('getPublicServerUrlEnvOverride ignores a leaked global HAPPIER_PUBLIC_SERVER_URL when the stack env does not set one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-server-urls-'));
  const envPath = join(dir, 'stack.env');
  await writeFile(
    envPath,
    [
      'HAPPIER_STACK_STACK=main',
      'HAPPIER_STACK_SERVER_PORT=4102',
      'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
      'HAPPIER_STACK_TAILSCALE_SERVE=0',
      '',
    ].join('\n'),
    'utf-8'
  );

  const out = getPublicServerUrlEnvOverride({
    env: {
      HAPPIER_STACK_STACK: 'main',
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_PUBLIC_SERVER_URL: 'https://public.machine.example.test',
    },
    serverPort: 4102,
  });

  assert.equal(out.envPublicUrl, '');
  assert.equal(out.publicServerUrl, 'http://localhost:4102');
});

test('getPublicServerUrlEnvOverride uses HAPPIER_STACK_STORAGE_DIR when resolving fallback stack env paths', async (t) => {
  const { storageDir, stackName } = await createIsolatedStackStorage(t);
  await writeStackEnvAtStorageRoot(
    storageDir,
    stackName,
    [
      'HAPPIER_STACK_SERVER_PORT=4102',
      'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
      'HAPPIER_STACK_TAILSCALE_SERVE=0',
      '',
    ].join('\n')
  );

  const out = getPublicServerUrlEnvOverride({
    env: {
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_PUBLIC_SERVER_URL: 'https://public.machine.example.test',
    },
    serverPort: 4102,
  });

  assert.equal(out.envPublicUrl, '');
  assert.equal(out.publicServerUrl, 'http://localhost:4102');
});

test('getPublicServerUrlEnvOverride ignores a leaked global HAPPIER_PUBLIC_SERVER_URL for non-main stacks when no stack env file exists', async (t) => {
  const { storageDir, stackName } = await createIsolatedStackStorage(t);
  const out = getPublicServerUrlEnvOverride({
    env: {
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_PUBLIC_SERVER_URL: 'https://public.machine.example.test',
    },
    serverPort: 4102,
  });

  assert.equal(out.envPublicUrl, '');
  assert.equal(out.publicServerUrl, 'http://localhost:4102');
});

test('getWebappUrlEnvOverride uses HAPPIER_STACK_STORAGE_DIR when resolving fallback stack env paths', async (t) => {
  const { storageDir, stackName } = await createIsolatedStackStorage(t);
  await writeStackEnvAtStorageRoot(
    storageDir,
    stackName,
    [
      'HAPPIER_STACK_SERVER_PORT=4102',
      'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
      'HAPPIER_STACK_TAILSCALE_SERVE=0',
      '',
    ].join('\n')
  );

  const out = getWebappUrlEnvOverride({
    env: {
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_WEBAPP_URL: 'https://hosted.example.test',
    },
  });

  assert.equal(out.envWebappUrl, '');
});

test('getWebappUrlEnvOverride ignores a leaked global HAPPIER_WEBAPP_URL when no stack env file exists', async (t) => {
  const { storageDir, stackName } = await createIsolatedStackStorage(t);
  const out = getWebappUrlEnvOverride({
    env: {
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_WEBAPP_URL: 'https://hosted.example.test',
    },
  });

  assert.equal(out.envWebappUrl, '');
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
  await writeFile(envPath, 'HAPPIER_STACK_SERVER_PORT=3005\n', 'utf-8');

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

test('resolveServerUrls ignores persisted tailscale relay access config when stack tailscale public-url preference is disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-server-urls-relay-'));
  const homeDir = join(dir, 'home');
  const binDir = join(dir, 'bin');
  const envPath = join(dir, 'stack.env');
  await mkdir(join(homeDir, '.happier', 'relay', 'access'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(homeDir, '.happier', 'relay', 'access', 'local.json'),
    JSON.stringify({ providerId: 'tailscaleFunnel' }),
    'utf-8'
  );
  const tailscaleBin = join(binDir, 'tailscale');
  await writeFile(
    tailscaleBin,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "status" && "${2:-}" == "--json" ]]; then',
      "  printf '%s\\n' '{\"BackendState\":\"Running\",\"Self\":{\"DNSName\":\"relay.example.test\"},\"HaveNodeKey\":true}'",
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "funnel" && "${2:-}" == "status" ]]; then',
      "  printf '%s\\n' 'https://relay.example.test' '|-- / proxy http://127.0.0.1:3005'",
      '  exit 0',
      'fi',
      'echo "unexpected args: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
    'utf-8'
  );
  await chmod(tailscaleBin, 0o755);
  await writeFile(envPath, 'HAPPIER_STACK_SERVER_URL=http://127.0.0.1:3005\n', 'utf-8');

  try {
    const out = await resolveServerUrls({
      env: {
        HOME: homeDir,
        HAPPIER_STACK_STACK: 'main',
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '0',
        HAPPIER_STACK_TAILSCALE_SERVE: '0',
        HAPPIER_TAILSCALE_BIN: tailscaleBin,
      },
      serverPort: 3005,
      allowEnable: false,
    });

    assert.equal(out.publicServerUrl, 'http://localhost:3005');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveServerUrls prefers the persisted tailscale relay access url when the current upstream matches and tailscale public urls are allowed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-server-urls-relay-'));
  const homeDir = join(dir, 'home');
  const binDir = join(dir, 'bin');
  const envPath = join(dir, 'stack.env');
  await mkdir(join(homeDir, '.happier', 'relay', 'access'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(homeDir, '.happier', 'relay', 'access', 'local.json'),
    JSON.stringify({ providerId: 'tailscaleFunnel' }),
    'utf-8'
  );
  const tailscaleBin = join(binDir, 'tailscale');
  await writeFile(
    tailscaleBin,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "status" && "${2:-}" == "--json" ]]; then',
      "  printf '%s\\n' '{\"BackendState\":\"Running\",\"Self\":{\"DNSName\":\"relay.example.test\"},\"HaveNodeKey\":true}'",
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "funnel" && "${2:-}" == "status" ]]; then',
      "  printf '%s\\n' 'https://relay.example.test' '|-- / proxy http://127.0.0.1:3005'",
      '  exit 0',
      'fi',
      'echo "unexpected args: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
    'utf-8'
  );
  await chmod(tailscaleBin, 0o755);
  await writeFile(envPath, 'HAPPIER_STACK_SERVER_PORT=3005\n', 'utf-8');

  try {
    const out = await resolveServerUrls({
      env: {
        HOME: homeDir,
        HAPPIER_STACK_STACK: 'main',
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '1',
        HAPPIER_STACK_TAILSCALE_SERVE: '0',
        HAPPIER_TAILSCALE_BIN: tailscaleBin,
      },
      serverPort: 3005,
      allowEnable: false,
    });

    assert.equal(out.publicServerUrl, 'https://relay.example.test');
    assert.equal(out.publicServerUrlSource, 'relay-access');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
