import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as tauriMode from './tauri_mode.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRootDir = resolve(join(__dirname, '../../../../..'));
const stackRootDir = join(repoRootDir, 'apps', 'stack');

function splitPathEntries(pathValue) {
  return String(pathValue ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

test('buildTuiChildArgs forces watch for dev forwarded commands', () => {
  assert.deepEqual(tauriMode.buildTuiChildArgs({ forwardedArgs: ['dev'], withTauri: false }), [
    'dev',
    '--watch',
    '--mobile',
  ]);
});

test('buildTuiChildArgs preserves an explicit web-only dev request', () => {
  assert.deepEqual(tauriMode.buildTuiChildArgs({ forwardedArgs: ['dev', '--no-mobile'], withTauri: false }), [
    'dev',
    '--no-mobile',
    '--watch',
  ]);
});

test('buildTuiChildArgs forces watch for Tauri dev commands while preserving no-browser', () => {
  assert.deepEqual(tauriMode.buildTuiChildArgs({ forwardedArgs: ['dev'], withTauri: true }), [
    'dev',
    '--watch',
    '--mobile',
    '--no-browser',
  ]);
});

test('buildTuiChildArgs preserves explicit no-watch for dev commands', () => {
  assert.deepEqual(tauriMode.buildTuiChildArgs({ forwardedArgs: ['dev', '--no-watch'], withTauri: false }), [
    'dev',
    '--no-watch',
    '--mobile',
  ]);
});

test('buildTuiChildArgs preserves explicit watch for dev commands', () => {
  assert.deepEqual(tauriMode.buildTuiChildArgs({ forwardedArgs: ['dev', '--watch'], withTauri: false }), [
    'dev',
    '--watch',
    '--mobile',
  ]);
});

test('buildTuiChildArgs forces watch for stack dev forwarded commands', () => {
  assert.deepEqual(tauriMode.buildTuiChildArgs({ forwardedArgs: ['stack', 'dev', 'exp1'], withTauri: false }), [
    'stack',
    'dev',
    'exp1',
    '--watch',
    '--mobile',
  ]);
});

test('buildTuiChildArgs does not force watch for start forwarded commands', () => {
  assert.deepEqual(tauriMode.buildTuiChildArgs({ forwardedArgs: ['start'], withTauri: false }), ['start']);
  assert.deepEqual(tauriMode.buildTuiChildArgs({ forwardedArgs: ['stack', 'start', 'exp1'], withTauri: false }), [
    'stack',
    'start',
    'exp1',
  ]);
});

test('buildTuiChildArgs does not force watch for non-dev forwarded commands', () => {
  assert.deepEqual(tauriMode.buildTuiChildArgs({ forwardedArgs: ['stack', 'auth', 'exp1', 'login'], withTauri: false }), [
    'stack',
    'auth',
    'exp1',
    'login',
  ]);
});

test('buildTuiRestartChildArgs preserves the active launch contract and adds restart exactly once', () => {
  assert.deepEqual(
    tauriMode.buildTuiRestartChildArgs({
      childArgs: ['stack', 'dev', 'exp1', '--watch', '--no-browser'],
    }),
    ['stack', 'dev', 'exp1', '--watch', '--no-browser', '--restart'],
  );
  assert.deepEqual(
    tauriMode.buildTuiRestartChildArgs({
      childArgs: ['stack', 'dev', 'exp1', '--restart', '--watch', '--restart', '--no-browser'],
    }),
    ['stack', 'dev', 'exp1', '--watch', '--no-browser', '--restart'],
  );
});

test('buildTuiRestartChildArgs routes env-named plain commands through the canonical stack owner', () => {
  assert.deepEqual(
    tauriMode.buildTuiRestartChildArgs({
      childArgs: ['dev', '--watch', '--mobile'],
      stackName: 'env-stack',
    }),
    ['stack', 'dev', 'env-stack', '--watch', '--mobile', '--restart'],
  );
  assert.deepEqual(
    tauriMode.buildTuiRestartChildArgs({
      childArgs: ['start', '--runtime', '--no-browser'],
      stackName: 'runtime-stack',
    }),
    ['stack', 'start', 'runtime-stack', '--runtime', '--no-browser', '--restart'],
  );
});

test('buildTuiRestartChildArgs preserves source and runtime start modes', () => {
  assert.deepEqual(
    tauriMode.buildTuiRestartChildArgs({ childArgs: ['stack', 'start', 'source-stack', '--source'] }),
    ['stack', 'start', 'source-stack', '--source', '--restart'],
  );
  assert.deepEqual(
    tauriMode.buildTuiRestartChildArgs({
      childArgs: ['stack', 'start', 'runtime-stack', '--runtime'],
    }),
    ['stack', 'start', 'runtime-stack', '--runtime', '--restart'],
  );
});

test('buildTuiRestartChildArgs rejects dry-run and help launch modes', () => {
  for (const childArgs of [
    ['dev', '--json'],
    ['stack', 'start', 'runtime-stack', '--json'],
    ['dev', '--help'],
    ['stack', 'dev', 'source-stack', '-h'],
  ]) {
    assert.throws(
      () => tauriMode.buildTuiRestartChildArgs({ childArgs, stackName: 'env-stack' }),
      (error) => error?.code === 'ESTACKRESTARTCONTROLARG',
    );
  }
});

test('resolveTauriPaneSpawnConfig builds a Tauri env with cargo available even when HOME is stack-isolated', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-pane-realhome-${Date.now()}`, { recursive: true });
  const isolatedHome = await mkdir(`${tmpdir()}/happier-tauri-pane-isolatedhome-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const { invocation, env } = tauriMode.resolveTauriPaneSpawnConfig({
    rootDir: stackRootDir,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
    },
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args?.[0], join(repoRootDir, 'apps', 'stack', 'scripts', 'tauri_dev.mjs'));
  assert.equal(invocation.cwd, repoRootDir);

  const escapedCargoBinDir = cargoBinDir.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(String(env?.PATH ?? ''), new RegExp(`^${escapedCargoBinDir}`));
  const entries = splitPathEntries(env.PATH);
  assert.ok(entries.includes('/usr/bin'));
  assert.ok(entries.includes('/bin'));
  assert.equal(env.CARGO, cargoBinary);
  assert.equal(env.HAPPIER_STACK_TUI, '1');
});

test('resolveTauriPaneSpawnConfig exports rustup homes for the real user cargo toolchain', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-pane-rustup-home-${Date.now()}`, { recursive: true });
  const isolatedHome = await mkdir(`${tmpdir()}/happier-tauri-pane-rustup-isolated-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const { env } = tauriMode.resolveTauriPaneSpawnConfig({
    rootDir: stackRootDir,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
    },
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(env.CARGO_HOME, `${realHome}/.cargo`);
  assert.equal(env.RUSTUP_HOME, `${realHome}/.rustup`);
  assert.equal(env.HOME, realHome);
  assert.equal(env.USERPROFILE, realHome);
});

test('resolveTauriPaneSpawnConfig preserves the host PATH while prepending cargo and keeping stack PATH entries', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-pane-host-path-home-${Date.now()}`, { recursive: true });
  const isolatedHome = await mkdir(`${tmpdir()}/happier-tauri-pane-host-path-isolated-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `/host/bin${process.platform === 'win32' ? ';' : ':'}/usr/bin`;
  try {
    const { env } = tauriMode.resolveTauriPaneSpawnConfig({
      rootDir: stackRootDir,
      env: {
        PATH: '/stack/bin',
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
      },
      resolveUserHomeDir: () => realHome,
    });

    const entries = splitPathEntries(env.PATH);
    assert.equal(entries[0], cargoBinDir);
    assert.equal(entries[1], dirname(process.execPath));
    assert.ok(entries.includes('/stack/bin'));
    assert.ok(entries.includes('/host/bin'));
    assert.ok(entries.includes('/usr/bin'));
  } finally {
    process.env.PATH = originalPath;
  }
});

test('resolveTauriPaneSpawnConfig can pin the TUI-orchestrated Expo port and skip redundant Expo waiting', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-pane-orchestrated-home-${Date.now()}`, { recursive: true });
  const isolatedHome = await mkdir(`${tmpdir()}/happier-tauri-pane-orchestrated-isolated-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const { env } = tauriMode.resolveTauriPaneSpawnConfig({
    rootDir: stackRootDir,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      HAPPIER_STACK_EXPO_DEV_PORT: '19364',
      HAPPIER_STACK_TAURI_WAIT_FOR_EXPO: '1',
    },
    expoPort: 24876,
    skipExpoWait: true,
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(env.HAPPIER_STACK_EXPO_DEV_PORT, '24876');
  assert.equal(env.HAPPIER_STACK_TAURI_WAIT_FOR_EXPO, '0');
});

test('buildTauriPaneEnv can force a clean Expo cache for TUI-managed Tauri runs', () => {
  const env = tauriMode.buildTauriPaneEnv({
    env: { PATH: '/usr/bin:/bin' },
    forceExpoClearCache: true,
  });

  assert.equal(env.HAPPIER_STACK_TUI, '1');
  assert.equal(env.HAPPIER_STACK_EXPO_CLEAR_CACHE, '1');
});

test('buildTauriPaneEnv preserves an explicit Expo cache opt-out', () => {
  const env = tauriMode.buildTauriPaneEnv({
    env: {
      PATH: '/usr/bin:/bin',
      HAPPIER_STACK_EXPO_CLEAR_CACHE: '0',
    },
    forceExpoClearCache: true,
  });

  assert.equal(env.HAPPIER_STACK_EXPO_CLEAR_CACHE, '0');
});

test('waitForTauriPaneExpoReady waits for the TUI runtime Expo port to become reachable', async () => {
  assert.equal(typeof tauriMode.waitForTauriPaneExpoReady, 'function');

  const runtimeStates = [
    { expo: {} },
    { expo: { port: 19364 } },
    { expo: { port: 19364 } },
  ];
  const checkedPorts = [];
  const delays = [];
  const result = await tauriMode.waitForTauriPaneExpoReady(
    {
      stackName: 'test-stack',
      timeoutMs: 50,
      intervalMs: 5,
    },
    {
      readRuntimeStateImpl: async () => runtimeStates.shift() ?? { expo: { port: 19364 } },
      looksLikeExpoMetroImpl: async ({ port }) => {
        checkedPorts.push(port);
        return checkedPorts.length >= 2;
      },
      delayImpl: async (ms) => {
        delays.push(ms);
      },
      nowMsImpl: (() => {
        let now = 0;
        return () => {
          now += 5;
          return now;
        };
      })(),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.port, 19364);
  assert.deepEqual(checkedPorts, [19364, 19364]);
  assert.equal(delays.length >= 1, true);
});
