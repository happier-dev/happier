import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildStackTauriDevProcessInvocation,
  buildTauriDevInvocation,
  buildTauriRuntimeEnv,
  resolveTauriDevUrl,
} from './tauri_dev.mjs';
import { buildStackStableScopeId } from '../auth/stable_scope_id.mjs';
import { getDefaultAutostartPaths } from '../paths/paths.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRootDir = resolve(join(__dirname, '../../../../..'));
const stackRootDir = join(repoRootDir, 'apps', 'stack');

function splitPathEntries(pathValue) {
  return String(pathValue ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function cargoNeutralEnv(overrides = {}) {
  const {
    CARGO,
    CARGO_HOME,
    RUSTUP_HOME,
    HAPPIER_ACTIVE_SERVER_ID,
    HAPPIER_HOME_DIR,
    HAPPIER_SERVER_URL,
    HAPPIER_STACK_CLI_HOME_DIR,
    HAPPIER_STACK_ENV_FILE,
    HAPPIER_STACK_REPO_DIR,
    HAPPIER_STACK_SERVER_PORT,
    HAPPIER_STACK_STACK,
    HAPPIER_STACK_WEBAPP_PORT,
    HAPPIER_WEBAPP_URL,
    EXPO_PUBLIC_HAPPY_STORAGE_SCOPE,
    ...baseEnv
  } = process.env;
  return { ...baseEnv, ...overrides };
}

test('resolveTauriDevUrl points at the existing Expo dev server port', () => {
  assert.equal(resolveTauriDevUrl({ expoPort: 8081 }), 'http://localhost:8081');
});

test('buildTauriDevInvocation disables beforeDevCommand and reuses the existing Expo dev url', () => {
  const invocation = buildTauriDevInvocation({
    expoPort: 8081,
    configPath: 'src-tauri/tauri.publicdev.conf.json',
  });

  assert.equal(invocation.command, 'tauri');
  assert.ok(invocation.args.includes('dev'));
  assert.ok(invocation.args.includes('--no-dev-server-wait'));
  assert.ok(invocation.args.includes('--config'));
  assert.ok(invocation.args.includes('src-tauri/tauri.publicdev.conf.json'));

  const overrideIndex = invocation.args.indexOf('-c');
  assert.notEqual(overrideIndex, -1);
  const overrideJson = JSON.parse(String(invocation.args[overrideIndex + 1] ?? '{}'));
  assert.deepEqual(overrideJson, {
    build: {
      beforeDevCommand: '',
      devUrl: 'http://localhost:8081',
      frontendDist: null,
    },
  });
});

test('buildStackTauriDevProcessInvocation launches tauri from apps/ui/src-tauri with the repo-local binary', () => {
  const expectedTauriEntrypoint = join(repoRootDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

  const invocation = buildStackTauriDevProcessInvocation({
    rootDir: stackRootDir,
    env: cargoNeutralEnv(),
    configPath: 'src-tauri/tauri.publicdev.conf.json',
    configOverride: {
      build: {
        beforeDevCommand: '',
        devUrl: 'http://localhost:8081',
      },
    },
  });

  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args[0], expectedTauriEntrypoint);
  assert.equal(invocation.args[1], 'dev');
  const configIndex = invocation.args.indexOf('--config');
  assert.notEqual(configIndex, -1);
  assert.equal(invocation.args[configIndex + 1], 'tauri.publicdev.conf.json');
  const overrideIndex = invocation.args.indexOf('-c');
  assert.notEqual(overrideIndex, -1);
  const overrideJson = JSON.parse(String(invocation.args[overrideIndex + 1] ?? '{}'));
  assert.deepEqual(overrideJson, {
    build: {
      beforeDevCommand: '',
      devUrl: 'http://localhost:8081',
      frontendDist: null,
    },
  });
  assert.equal(invocation.cwd, join(repoRootDir, 'apps', 'ui', 'src-tauri'));
});

test('buildStackTauriDevProcessInvocation scopes the cargo target directory to the active stack', () => {
  const stackName = 'codex-bootstrap-qa-24534';
  const invocation = buildStackTauriDevProcessInvocation({
    rootDir: stackRootDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
    },
    configPath: 'src-tauri/tauri.publicdev.conf.json',
    configOverride: {
      build: {
        beforeDevCommand: '',
        devUrl: 'http://localhost:8081',
      },
    },
  });

  assert.equal(
    invocation.env?.CARGO_TARGET_DIR,
    `${getDefaultAutostartPaths({ ...process.env, HAPPIER_STACK_STACK: stackName }).baseDir}/tauri-target`
  );
});

test('buildStackTauriDevProcessInvocation uses the explicitly resolved UI dir even when stack env points elsewhere', async () => {
  const explicitUiDir = join(repoRootDir, 'apps', 'ui');
  const expectedTauriEntrypoint = join(repoRootDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  const fakeRepo = await mkdir(`${tmpdir()}/happier-tauri-bad-repo-${Date.now()}`, { recursive: true });

  const invocation = buildStackTauriDevProcessInvocation({
    rootDir: stackRootDir,
    repoRootDir: repoRootDir,
    uiDir: explicitUiDir,
    env: {
      ...process.env,
      HAPPIER_STACK_REPO_DIR: fakeRepo,
    },
    configPath: 'src-tauri/tauri.publicdev.conf.json',
    configOverride: {
      build: {
        beforeDevCommand: '',
        devUrl: 'http://localhost:8081',
      },
    },
  });

  assert.equal(invocation.cwd, join(explicitUiDir, 'src-tauri'));
  assert.equal(invocation.args[0], expectedTauriEntrypoint);
});

test('buildStackTauriDevProcessInvocation prepends the cargo bin directory when cargo is outside PATH', async () => {
  const cargoHome = await mkdir(`${tmpdir()}/happier-tauri-cargo-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${cargoHome}/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const invocation = buildStackTauriDevProcessInvocation({
    rootDir: stackRootDir,
    env: cargoNeutralEnv({
      PATH: '/usr/bin:/bin',
      CARGO_HOME: cargoHome,
    }),
    configPath: 'src-tauri/tauri.publicdev.conf.json',
    configOverride: {
      build: {
        beforeDevCommand: '',
        devUrl: 'http://localhost:8081',
      },
    },
  });

  assert.match(String(invocation.env?.PATH ?? ''), new RegExp(`^${cargoBinDir.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const entries = splitPathEntries(invocation.env?.PATH);
  assert.ok(entries.includes('/usr/bin'));
  assert.ok(entries.includes('/bin'));
  assert.equal(invocation.env?.CARGO, cargoBinary);
});

test('buildStackTauriDevProcessInvocation detects cargo under the real user home when HOME is stack-isolated', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-realhome-${Date.now()}`, { recursive: true });
  const isolatedHome = await mkdir(`${tmpdir()}/happier-tauri-isolatedhome-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const invocation = buildStackTauriDevProcessInvocation({
    rootDir: stackRootDir,
    env: cargoNeutralEnv({
      PATH: '/usr/bin:/bin',
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
    }),
    configPath: 'src-tauri/tauri.publicdev.conf.json',
    configOverride: {
      build: {
        beforeDevCommand: '',
        devUrl: 'http://localhost:8081',
      },
    },
    resolveUserHomeDir: () => realHome,
  });

  const escapedCargoBinDir = cargoBinDir.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    String(invocation.env?.PATH ?? ''),
    new RegExp(`^${escapedCargoBinDir}`)
  );
  assert.equal(invocation.env?.HOME, realHome);
  assert.equal(invocation.env?.USERPROFILE, realHome);
});

test('buildStackTauriDevProcessInvocation prefers cargo under the resolved user home when HOME is isolated even if PATH contains a cargo shim', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-realhome-prefer-${Date.now()}`, { recursive: true });
  const isolatedHome = await mkdir(`${tmpdir()}/happier-tauri-isolatedhome-prefer-${Date.now()}`, { recursive: true });
  const realCargoBinDir = `${realHome}/.cargo/bin`;
  const isolatedCargoBinDir = `${isolatedHome}/bin`;
  await mkdir(realCargoBinDir, { recursive: true });
  await mkdir(isolatedCargoBinDir, { recursive: true });

  const cargoName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const realCargoBinary = `${realCargoBinDir}/${cargoName}`;
  const isolatedCargoBinary = `${isolatedCargoBinDir}/${cargoName}`;
  await writeFile(realCargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await writeFile(isolatedCargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(realCargoBinary, 0o755);
  await chmod(isolatedCargoBinary, 0o755);

  const invocation = buildStackTauriDevProcessInvocation({
    rootDir: stackRootDir,
    env: cargoNeutralEnv({
      PATH: `${isolatedCargoBinDir}:/usr/bin:/bin`,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
    }),
    configPath: 'src-tauri/tauri.publicdev.conf.json',
    configOverride: {
      build: {
        beforeDevCommand: '',
        devUrl: 'http://localhost:8081',
      },
    },
    resolveUserHomeDir: () => realHome,
  });

  const escapedCargoBinDir = realCargoBinDir.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(String(invocation.env?.PATH ?? ''), new RegExp(`^${escapedCargoBinDir}`));
});

test('buildStackTauriDevProcessInvocation exports rustup homes for the detected user cargo toolchain', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-rustup-home-${Date.now()}`, { recursive: true });
  const isolatedHome = await mkdir(`${tmpdir()}/happier-tauri-rustup-isolated-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const invocation = buildStackTauriDevProcessInvocation({
    rootDir: stackRootDir,
    env: cargoNeutralEnv({
      PATH: '/usr/bin:/bin',
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
    }),
    configPath: 'src-tauri/tauri.publicdev.conf.json',
    configOverride: {
      build: {
        beforeDevCommand: '',
        devUrl: 'http://localhost:8081',
      },
    },
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(invocation.env?.CARGO_HOME, `${realHome}/.cargo`);
  assert.equal(invocation.env?.RUSTUP_HOME, `${realHome}/.rustup`);
});

test('buildStackTauriDevProcessInvocation inherits the stack-scoped server url and active server id from the stack CLI settings', async () => {
  const stackRootDir = '/Users/leeroy/Documents/Development/happier/dev/apps/stack';
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-stack-server-real-${Date.now()}`, { recursive: true });
  const isolatedHome = await mkdir(`${tmpdir()}/happier-tauri-stack-server-isolated-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${realHome}/.cargo/bin`;
  const cliHomeDir = `${tmpdir()}/happier-tauri-stack-cli-home-${Date.now()}`;
  await mkdir(cargoBinDir, { recursive: true });
  await mkdir(cliHomeDir, { recursive: true });

  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  await writeFile(
    `${cliHomeDir}/settings.json`,
    JSON.stringify(
      {
        schemaVersion: 5,
        activeServerId: 'stack_main__id_default',
        servers: {
          stack_main__id_default: {
            id: 'stack_main__id_default',
            name: 'Main',
            serverUrl: 'http://127.0.0.1:3005',
            localServerUrl: 'http://127.0.0.1:3005',
            webappUrl: 'http://localhost:8081',
            createdAt: Date.now() - 10_000,
            updatedAt: Date.now() - 10_000,
            lastUsedAt: Date.now() - 10_000,
          },
          'stack_activity-surfaces-qa__id_default': {
            id: 'stack_activity-surfaces-qa__id_default',
            name: 'Activity Surfaces QA',
            serverUrl: 'http://127.0.0.1:3009',
            localServerUrl: 'http://127.0.0.1:3009',
            webappUrl: 'http://localhost:8081',
            createdAt: Date.now() - 5_000,
            updatedAt: Date.now() - 5_000,
            lastUsedAt: Date.now() - 5_000,
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  const invocation = buildStackTauriDevProcessInvocation({
    rootDir: stackRootDir,
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      HAPPIER_STACK_STACK: 'activity-surfaces-qa',
      HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_SERVER_PORT: '3009',
      HAPPIER_HOME_DIR: '',
      HAPPIER_SERVER_URL: '',
      HAPPIER_ACTIVE_SERVER_ID: '',
    },
    configPath: 'src-tauri/tauri.publicdev.conf.json',
    configOverride: {
      build: {
        beforeDevCommand: '',
        devUrl: 'http://localhost:8081',
      },
    },
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(invocation.env?.HAPPIER_HOME_DIR, cliHomeDir);
  assert.equal(invocation.env?.HAPPIER_SERVER_URL, 'http://127.0.0.1:3009');
  assert.equal(invocation.env?.HAPPIER_ACTIVE_SERVER_ID, 'stack_activity-surfaces-qa__id_default');
});

test('buildStackTauriDevProcessInvocation seeds stack-scoped home and server env from the stack env file when the shell is missing them', async () => {
  const stackRootDir = '/Users/leeroy/Documents/Development/happier/dev/apps/stack';
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-stack-env-real-${Date.now()}`, { recursive: true });
  const isolatedHome = await mkdir(`${tmpdir()}/happier-tauri-stack-env-isolated-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${realHome}/.cargo/bin`;
  const cliHomeDir = `${tmpdir()}/happier-tauri-stack-env-cli-home-${Date.now()}`;
  await mkdir(cargoBinDir, { recursive: true });
  await mkdir(cliHomeDir, { recursive: true });

  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  await writeFile(
    `${cliHomeDir}/settings.json`,
    JSON.stringify(
      {
        schemaVersion: 5,
        activeServerId: 'stack_main__id_default',
        servers: {
          stack_main__id_default: {
            id: 'stack_main__id_default',
            serverUrl: 'http://127.0.0.1:3005',
            localServerUrl: 'http://127.0.0.1:3005',
            webappUrl: 'http://localhost:8081',
          },
          'stack_activity-surfaces-qa__id_default': {
            id: 'stack_activity-surfaces-qa__id_default',
            serverUrl: 'http://127.0.0.1:3009',
            localServerUrl: 'http://127.0.0.1:3009',
            webappUrl: 'http://localhost:8081',
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  const invocation = buildStackTauriDevProcessInvocation({
    rootDir: stackRootDir,
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      HAPPIER_STACK_STACK: 'activity-surfaces-qa',
      HAPPIER_HOME_DIR: '',
      HAPPIER_SERVER_URL: '',
      HAPPIER_ACTIVE_SERVER_ID: '',
    },
    stackEnv: {
      HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_SERVER_PORT: '3009',
    },
    configPath: 'src-tauri/tauri.publicdev.conf.json',
    configOverride: {
      build: {
        beforeDevCommand: '',
        devUrl: 'http://localhost:8081',
      },
    },
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(invocation.env?.HAPPIER_HOME_DIR, cliHomeDir);
  assert.equal(invocation.env?.HAPPIER_SERVER_URL, 'http://127.0.0.1:3009');
  assert.equal(invocation.env?.HAPPIER_ACTIVE_SERVER_ID, 'stack_activity-surfaces-qa__id_default');
});

test('buildStackTauriDevProcessInvocation lets the stack env file override stale shell server selection', async () => {
  const stackRootDir = '/Users/leeroy/Documents/Development/happier/dev/apps/stack';
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-stack-env-authoritative-real-${Date.now()}`, { recursive: true });
  const isolatedHome = await mkdir(`${tmpdir()}/happier-tauri-stack-env-authoritative-isolated-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${realHome}/.cargo/bin`;
  const cliHomeDir = `${tmpdir()}/happier-tauri-stack-env-authoritative-cli-home-${Date.now()}`;
  await mkdir(cargoBinDir, { recursive: true });
  await mkdir(cliHomeDir, { recursive: true });

  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const stackName = 'activity-surfaces-qa';
  const stackServerId = `stack_${stackName}__id_default`;
  await writeFile(
    `${cliHomeDir}/settings.json`,
    JSON.stringify(
      {
        schemaVersion: 5,
        activeServerId: stackServerId,
        servers: {
          [stackServerId]: {
            id: stackServerId,
            name: 'Activity Surfaces QA',
            serverUrl: 'http://127.0.0.1:3009',
            localServerUrl: 'http://127.0.0.1:3009',
            webappUrl: 'http://localhost:3009',
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  const invocation = buildStackTauriDevProcessInvocation({
    rootDir: stackRootDir,
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_SERVER_PORT: '3005',
      HAPPIER_STACK_CLI_HOME_DIR: `${tmpdir()}/unused-stack-cli-home-${Date.now()}`,
      HAPPIER_HOME_DIR: '',
      HAPPIER_SERVER_URL: 'http://remote.example.test:4010',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
    },
    stackEnv: {
      HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_SERVER_PORT: '3009',
      HAPPIER_STACK_STACK: stackName,
    },
    configPath: 'src-tauri/tauri.publicdev.conf.json',
    configOverride: {
      build: {
        beforeDevCommand: '',
        devUrl: 'http://localhost:8081',
      },
    },
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(invocation.env?.HAPPIER_HOME_DIR, cliHomeDir);
  assert.equal(invocation.env?.HAPPIER_SERVER_URL, 'http://127.0.0.1:3009');
  assert.equal(invocation.env?.HAPPIER_WEBAPP_URL, 'http://localhost:3009');
  assert.equal(invocation.env?.HAPPIER_ACTIVE_SERVER_ID, stackServerId);
});

test('buildTauriRuntimeEnv infers rustup home when cargo comes from an explicit CARGO_HOME but HOME is isolated', async () => {
  if (process.platform === 'win32') {
    // Path inference uses `.cargo/bin` semantics on POSIX; keep Windows coverage in the invocation tests.
    return;
  }

  const realHome = await mkdir(`${tmpdir()}/happier-tauri-rustup-infer-home-${Date.now()}`, { recursive: true });
  const isolatedHome = await mkdir(`${tmpdir()}/happier-tauri-rustup-infer-isolated-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  const cargoBinary = `${cargoBinDir}/cargo`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const env = buildTauriRuntimeEnv({
    env: cargoNeutralEnv({
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      PATH: '/usr/bin:/bin',
      CARGO_HOME: `${realHome}/.cargo`,
    }),
    resolveUserHomeDir: () => isolatedHome,
  });

  assert.equal(env.CARGO_HOME, `${realHome}/.cargo`);
  assert.equal(env.RUSTUP_HOME, `${realHome}/.rustup`);
});

test('buildStackTauriDevProcessInvocation preserves the host PATH while keeping stack and cargo entries', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-host-path-home-${Date.now()}`, { recursive: true });
  const isolatedHome = await mkdir(`${tmpdir()}/happier-tauri-host-path-isolated-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `/host/bin${process.platform === 'win32' ? ';' : ':'}/usr/bin`;
  try {
    const invocation = buildStackTauriDevProcessInvocation({
      rootDir: stackRootDir,
      env: cargoNeutralEnv({
        PATH: '/stack/bin',
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
      }),
      configPath: 'src-tauri/tauri.publicdev.conf.json',
      configOverride: {
        build: {
          beforeDevCommand: '',
          devUrl: 'http://localhost:8081',
        },
      },
      resolveUserHomeDir: () => realHome,
    });

    const entries = splitPathEntries(invocation.env?.PATH);
    const nodeBinDir = process.execPath.replace(/[/\\][^/\\]+$/, '');
    assert.equal(entries[0], cargoBinDir);
    assert.equal(entries[1], nodeBinDir);
    assert.equal(entries[2], '/stack/bin');
    assert.ok(entries.includes('/host/bin'));
    assert.ok(entries.includes('/usr/bin'));
  } finally {
    process.env.PATH = originalPath;
  }
});

test('buildTauriRuntimeEnv prepends the current Node binary directory for GUI-launched sidecars', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-node-path-home-${Date.now()}`, { recursive: true });
  const isolatedHome = await mkdir(`${tmpdir()}/happier-tauri-node-path-isolated-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = '/host/bin:/usr/bin';
  try {
    const env = buildTauriRuntimeEnv({
      env: cargoNeutralEnv({
        PATH: '/stack/bin',
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        CARGO_HOME: `${realHome}/.cargo`,
      }),
      resolveUserHomeDir: () => realHome,
    });

    const entries = splitPathEntries(env.PATH);
    assert.equal(entries[0], cargoBinDir);
    assert.equal(entries[1], process.execPath.replace(/[/\\][^/\\]+$/, ''));
    assert.ok(entries.includes('/stack/bin'));
    assert.ok(entries.includes('/host/bin'));
  } finally {
    process.env.PATH = originalPath;
  }
});

test('buildTauriRuntimeEnv replaces an invalid CARGO env var with the resolved cargo binary path', async () => {
  if (process.platform === 'win32') {
    // Environment variable semantics differ on Windows; keep the fix scoped to POSIX to avoid flaky shebang execution.
    return;
  }

  const cargoHome = await mkdir(`${tmpdir()}/happier-tauri-invalid-cargo-env-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${cargoHome}/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  const cargoBinary = `${cargoBinDir}/cargo`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const env = buildTauriRuntimeEnv({
    env: cargoNeutralEnv({
      PATH: '/usr/bin:/bin',
      CARGO_HOME: cargoHome,
      CARGO: '/no/such/cargo',
    }),
  });

  assert.equal(env.CARGO, cargoBinary);
});

test('buildTauriRuntimeEnv overrides a non-path CARGO env var with the resolved cargo binary path', async () => {
  if (process.platform === 'win32') {
    // Environment variable semantics differ on Windows; keep the fix scoped to POSIX to avoid flaky shebang execution.
    return;
  }

  const cargoHome = await mkdir(`${tmpdir()}/happier-tauri-nonpath-cargo-env-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${cargoHome}/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  const cargoBinary = `${cargoBinDir}/cargo`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const env = buildTauriRuntimeEnv({
    env: cargoNeutralEnv({
      PATH: '/usr/bin:/bin',
      CARGO_HOME: cargoHome,
      CARGO: 'cargo',
    }),
  });

  assert.equal(env.CARGO, cargoBinary);
});

test('buildTauriRuntimeEnv mirrors HAPPIER_STACK_CLI_HOME_DIR into HAPPIER_HOME_DIR when the canonical home is missing', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-stack-home-real-${Date.now()}`, { recursive: true });
  const stackCliHome = `${realHome}/stack-cli-home`;
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  await mkdir(stackCliHome, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const env = buildTauriRuntimeEnv({
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
      HAPPIER_STACK_CLI_HOME_DIR: stackCliHome,
      HAPPIER_HOME_DIR: '',
    },
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(env.HAPPIER_STACK_CLI_HOME_DIR, stackCliHome);
  assert.equal(env.HAPPIER_HOME_DIR, stackCliHome);
});

test('buildTauriRuntimeEnv preserves an explicit HAPPIER_HOME_DIR instead of overwriting it from HAPPIER_STACK_CLI_HOME_DIR', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-stack-home-preserve-${Date.now()}`, { recursive: true });
  const explicitHome = `${realHome}/explicit-home`;
  const stackCliHome = `${realHome}/stack-cli-home`;
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  await mkdir(explicitHome, { recursive: true });
  await mkdir(stackCliHome, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const env = buildTauriRuntimeEnv({
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
      HAPPIER_STACK_CLI_HOME_DIR: stackCliHome,
      HAPPIER_HOME_DIR: explicitHome,
    },
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(env.HAPPIER_STACK_CLI_HOME_DIR, stackCliHome);
  assert.equal(env.HAPPIER_HOME_DIR, explicitHome);
});

test('buildTauriRuntimeEnv overrides stale HAPPIER_SERVER_URL with the stack-local server and prefers the matching stack server profile id', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-stack-scope-real-${Date.now()}`, { recursive: true });
  const stackCliHome = `${realHome}/stack-cli-home`;
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  await mkdir(stackCliHome, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const stackName = 'activity-surfaces-qa';
  const expectedServerId = buildStackStableScopeId({ stackName, cliIdentity: 'default' });
  await writeFile(
    `${stackCliHome}/settings.json`,
    JSON.stringify(
      {
        schemaVersion: 6,
        activeServerId: 'cloud',
        servers: {
          cloud: {
            id: 'cloud',
            name: 'Happier Cloud',
            serverUrl: 'https://api.happier.dev',
            webappUrl: 'https://app.happier.dev',
          },
          [expectedServerId]: {
            id: expectedServerId,
            name: 'Stack activity-surfaces-qa',
            serverUrl: 'http://127.0.0.1:3009',
            localServerUrl: 'http://127.0.0.1:3009',
            webappUrl: 'http://localhost:3009',
          },
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  const env = buildTauriRuntimeEnv({
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_CLI_HOME_DIR: stackCliHome,
      HAPPIER_STACK_SERVER_PORT: '3009',
      HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
      HAPPIER_WEBAPP_URL: '',
    },
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(env.HAPPIER_SERVER_URL, 'http://127.0.0.1:3009');
  assert.equal(env.HAPPIER_WEBAPP_URL, 'http://localhost:3009');
  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, expectedServerId);
});

test('buildTauriRuntimeEnv falls back to the stable stack scope id when CLI settings do not contain a matching stack server profile', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-stack-scope-fallback-${Date.now()}`, { recursive: true });
  const stackCliHome = `${realHome}/stack-cli-home`;
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  await mkdir(stackCliHome, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const stackName = 'activity-surfaces-qa';
  const expectedServerId = buildStackStableScopeId({ stackName, cliIdentity: 'default' });
  await writeFile(
    `${stackCliHome}/settings.json`,
    JSON.stringify(
      {
        schemaVersion: 6,
        activeServerId: 'stack_main__id_default',
        servers: {
          stack_main__id_default: {
            id: 'stack_main__id_default',
            name: 'Main Stack',
            serverUrl: 'http://127.0.0.1:3005',
            localServerUrl: 'http://127.0.0.1:3005',
            webappUrl: 'http://localhost:3005',
          },
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  const env = buildTauriRuntimeEnv({
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_CLI_HOME_DIR: stackCliHome,
      HAPPIER_STACK_SERVER_PORT: '3009',
      HAPPIER_SERVER_URL: '',
      HAPPIER_WEBAPP_URL: '',
    },
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(env.HAPPIER_SERVER_URL, 'http://127.0.0.1:3009');
  assert.equal(env.HAPPIER_WEBAPP_URL, 'http://localhost:3009');
  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, expectedServerId);
});

test('buildTauriRuntimeEnv derives a stack-scoped HAPPIER_SERVER_URL and active server id from stack env when they are missing', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-stack-scope-${Date.now()}`, { recursive: true });
  const stackCliHome = `${realHome}/stack-cli-home`;
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  await mkdir(stackCliHome, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const env = buildTauriRuntimeEnv({
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
      HAPPIER_STACK_STACK: 'activity-surfaces-qa',
      HAPPIER_STACK_SERVER_PORT: '3009',
      HAPPIER_STACK_CLI_HOME_DIR: stackCliHome,
      HAPPIER_HOME_DIR: '',
      HAPPIER_SERVER_URL: '',
      HAPPIER_ACTIVE_SERVER_ID: '',
    },
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(env.HAPPIER_HOME_DIR, stackCliHome);
  assert.equal(env.HAPPIER_SERVER_URL, 'http://127.0.0.1:3009');
  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, 'stack_activity-surfaces-qa__id_default');
});

test('buildTauriRuntimeEnv seeds EXPO_PUBLIC_HAPPY_STORAGE_SCOPE for stack-owned Tauri launches when it is missing', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-storage-scope-${Date.now()}`, { recursive: true });
  const stackCliHome = `${realHome}/stack-cli-home`;
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  await mkdir(stackCliHome, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const env = buildTauriRuntimeEnv({
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
      HAPPIER_STACK_STACK: 'activity-surfaces-qa',
      HAPPIER_STACK_CLI_HOME_DIR: stackCliHome,
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: '',
    },
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE, 'activity-surfaces-qa');
});

test('buildTauriRuntimeEnv preserves explicit remote server selection when only HAPPIER_STACK_STACK is present', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-stack-name-only-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const env = buildTauriRuntimeEnv({
    env: cargoNeutralEnv({
      PATH: '/usr/bin:/bin',
      HAPPIER_STACK_STACK: 'activity-surfaces-qa',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_HOME_DIR: '',
    }),
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(env.HAPPIER_SERVER_URL, 'https://api.happier.dev');
  assert.equal(env.HAPPIER_WEBAPP_URL, 'https://app.happier.dev');
  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, 'cloud');
});

test('buildTauriRuntimeEnv prefers a matching server id from stack CLI settings over the derived stable scope', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-stack-settings-${Date.now()}`, { recursive: true });
  const stackCliHome = `${realHome}/stack-cli-home`;
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  await mkdir(stackCliHome, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);
  await writeFile(
    `${stackCliHome}/settings.json`,
    JSON.stringify(
      {
        schemaVersion: 6,
        activeServerId: 'custom-stack-server',
        servers: {
          'custom-stack-server': {
            id: 'custom-stack-server',
            serverUrl: 'http://127.0.0.1:3009',
            localServerUrl: 'http://127.0.0.1:3009',
            webappUrl: 'http://localhost:3009',
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  const env = buildTauriRuntimeEnv({
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
      HAPPIER_STACK_STACK: 'activity-surfaces-qa',
      HAPPIER_STACK_SERVER_PORT: '3009',
      HAPPIER_STACK_CLI_HOME_DIR: stackCliHome,
      HAPPIER_HOME_DIR: '',
      HAPPIER_SERVER_URL: '',
      HAPPIER_ACTIVE_SERVER_ID: '',
    },
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(env.HAPPIER_SERVER_URL, 'http://127.0.0.1:3009');
  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, 'custom-stack-server');
});

test('buildTauriRuntimeEnv preserves explicit server selection instead of overwriting it from stack defaults', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-stack-scope-preserve-${Date.now()}`, { recursive: true });
  const stackCliHome = `${realHome}/stack-cli-home`;
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  await mkdir(stackCliHome, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const env = buildTauriRuntimeEnv({
    env: cargoNeutralEnv({
      PATH: '/usr/bin:/bin',
      HAPPIER_STACK_STACK: 'activity-surfaces-qa',
      HAPPIER_STACK_CLI_HOME_DIR: stackCliHome,
      HAPPIER_STACK_SERVER_PORT: '3009',
      HAPPIER_SERVER_URL: 'http://remote.example.test:4010',
      HAPPIER_ACTIVE_SERVER_ID: 'env_deadbeef',
    }),
    resolveUserHomeDir: () => realHome,
  });

  assert.equal(env.HAPPIER_SERVER_URL, 'http://remote.example.test:4010');
  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, 'env_deadbeef');
});

test('buildStackTauriDevProcessInvocation fails fast with a friendly error when cargo is unavailable', async () => {
  const isolatedHome = await mkdir(`${tmpdir()}/happier-tauri-missing-cargo-${Date.now()}`, { recursive: true });
  const originalPath = process.env.PATH;

  process.env.PATH = '/usr/bin:/bin';
  try {
    assert.throws(
      () =>
        buildStackTauriDevProcessInvocation({
          rootDir: stackRootDir,
          env: cargoNeutralEnv({
            PATH: '/usr/bin:/bin',
            HOME: isolatedHome,
            USERPROFILE: isolatedHome,
            CARGO_HOME: `${isolatedHome}/.cargo-missing`,
          }),
          configPath: 'src-tauri/tauri.publicdev.conf.json',
          configOverride: {
            build: {
              beforeDevCommand: '',
              devUrl: 'http://localhost:8081',
            },
          },
          resolveUserHomeDir: () => isolatedHome,
        }),
      /cargo.*not found/i
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test('buildStackTauriDevProcessInvocation rejects a cargo binary that cannot execute (prevents tauri cargo-metadata ENOENT)', async () => {
  if (process.platform === 'win32') {
    // The Windows path uses cargo.exe; exercising a broken executable is not portable in this suite.
    return;
  }

  const cargoHome = await mkdir(`${tmpdir()}/happier-tauri-broken-cargo-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${cargoHome}/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  const cargoBinary = `${cargoBinDir}/cargo`;
  await writeFile(cargoBinary, '#!/no/such/interpreter\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  assert.throws(
    () =>
      buildStackTauriDevProcessInvocation({
        rootDir: stackRootDir,
        env: {
          ...process.env,
          PATH: '/usr/bin:/bin',
          CARGO_HOME: cargoHome,
        },
        configPath: 'src-tauri/tauri.publicdev.conf.json',
        configOverride: {
          build: {
            beforeDevCommand: '',
            devUrl: 'http://localhost:8081',
          },
        },
      }),
    /cargo.*failed|cargo.*unable|cargo.*cannot/i
  );
});
