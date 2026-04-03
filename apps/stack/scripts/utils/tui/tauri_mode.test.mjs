import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTauriPaneSpawnConfig } from './tauri_mode.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRootDir = resolve(join(__dirname, '../../../../..'));
const stackRootDir = join(repoRootDir, 'apps', 'stack');

function splitPathEntries(pathValue) {
  return String(pathValue ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

test('resolveTauriPaneSpawnConfig builds a Tauri env with cargo available even when HOME is stack-isolated', async () => {
  const realHome = await mkdir(`${tmpdir()}/happier-tauri-pane-realhome-${Date.now()}`, { recursive: true });
  const isolatedHome = await mkdir(`${tmpdir()}/happier-tauri-pane-isolatedhome-${Date.now()}`, { recursive: true });
  const cargoBinDir = `${realHome}/.cargo/bin`;
  await mkdir(cargoBinDir, { recursive: true });
  const cargoBinary = `${cargoBinDir}/${process.platform === 'win32' ? 'cargo.exe' : 'cargo'}`;
  await writeFile(cargoBinary, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(cargoBinary, 0o755);

  const { invocation, env } = resolveTauriPaneSpawnConfig({
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

  const { env } = resolveTauriPaneSpawnConfig({
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
    const { env } = resolveTauriPaneSpawnConfig({
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
