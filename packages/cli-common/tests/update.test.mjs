import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computePreviewVersion,
  compareVersions,
  normalizeSemverBase,
  acquireSingleFlightLock,
  resolveNpmPackageNameOverride,
  shouldNotifyUpdate,
  readUpdateCache,
  writeUpdateCache,
  resolveSpawnDetachedNodeInvocation,
  readNpmDistTagVersion,
  installRuntimeFromNpm,
} from '../dist/update/index.js';

async function withPlatform(platform, run) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) return await run();

  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

async function createWindowsNpmShimFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'happier-cli-common-winshim-'));
  const binDir = join(dir, 'bin');
  await mkdir(binDir, { recursive: true });

  const nodeExecPath = process.execPath.replace(/\\/g, '\\\\');
  const cmdExePath = join(binDir, 'cmd.exe');
  const npmCmdPath = join(binDir, 'npm.cmd');

  const cmdExeScript = `#!${nodeExecPath}
const cp = require('node:child_process');

function splitCommandLine(raw) {
  const tokens = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    let ch = raw[i];
    if (ch === '^' && i + 1 < raw.length) {
      const next = raw[i + 1];
      i += 1;
      if (next === ' ' || next === '\\t') {
        current += next;
        continue;
      }
      ch = next;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\\t')) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

const args = process.argv.slice(2);
const cIndex = args.findIndex((a) => String(a).toLowerCase() === '/c');
const rest = cIndex === -1 ? [] : args.slice(cIndex + 1);
if (rest.length === 0) process.exit(1);

let commandLine = rest.join(' ');
if (rest.length === 1) commandLine = rest[0];
if (commandLine.startsWith('"') && commandLine.endsWith('"')) commandLine = commandLine.slice(1, -1);

const tokens = splitCommandLine(commandLine);
if (tokens.length === 0) process.exit(1);

const command = tokens[0];
const commandArgs = tokens.slice(1);
const child = cp.spawn(command, commandArgs, { stdio: 'inherit', env: process.env });

child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', () => process.exit(127));
`;

  const npmCmdScript = `#!${nodeExecPath}
const args = process.argv.slice(2);
if (args[0] === 'view' && typeof args[1] === 'string' && args[2] === 'version') {
  process.stdout.write('1.2.3\\n');
  process.exit(0);
}
if (args[0] === 'install') {
  process.exit(0);
}
process.exit(1);
`;

  await writeFile(cmdExePath, cmdExeScript, 'utf8');
  await chmod(cmdExePath, 0o755);
  await writeFile(npmCmdPath, npmCmdScript, 'utf8');
  await chmod(npmCmdPath, 0o755);

  return {
    dir,
    binDir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('normalizeSemverBase strips prerelease', () => {
  assert.equal(normalizeSemverBase('1.2.3-preview.4'), '1.2.3');
});

test('computePreviewVersion returns X.Y.Z-preview.N', () => {
  assert.equal(computePreviewVersion({ baseVersion: '1.2.3', runNumber: 7 }), '1.2.3-preview.7');
});

test('shouldNotifyUpdate respects interval and command exclusions', () => {
  const now = 100_000;
  assert.equal(
    shouldNotifyUpdate({
      isTTY: true,
      cmd: 'self',
      updateAvailable: true,
      latest: '9.9.9',
      notifiedAt: null,
      notifyIntervalMs: 1000,
      nowMs: now,
    }),
    false,
  );
  assert.equal(
    shouldNotifyUpdate({
      isTTY: true,
      cmd: 'start',
      updateAvailable: true,
      latest: '9.9.9',
      notifiedAt: now - 500,
      notifyIntervalMs: 1000,
      nowMs: now,
    }),
    false,
  );
  assert.equal(
    shouldNotifyUpdate({
      isTTY: true,
      cmd: 'start',
      updateAvailable: true,
      latest: '9.9.9',
      notifiedAt: now - 2000,
      notifyIntervalMs: 1000,
      nowMs: now,
    }),
    true,
  );
});

test('readUpdateCache/writeUpdateCache round-trip JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-cli-common-'));
  const path = join(dir, 'update.json');
  try {
    writeUpdateCache(path, {
      checkedAt: 1,
      latest: '2.0.0',
      current: '1.0.0',
      runtimeVersion: null,
      invokerVersion: '1.0.0',
      updateAvailable: true,
      notifiedAt: null,
    });
    const cache = readUpdateCache(path);
    assert.equal(cache?.latest, '2.0.0');

    // ensure file is valid JSON too
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.latest, '2.0.0');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('compareVersions orders preview prereleases by numeric run number', () => {
  assert.equal(compareVersions('1.2.3-preview.10', '1.2.3-preview.2') > 0, true);
  assert.equal(compareVersions('1.2.3-preview.2', '1.2.3-preview.10') < 0, true);
});

test('resolveNpmPackageNameOverride uses fallback for invalid overrides', () => {
  assert.equal(
    resolveNpmPackageNameOverride({ envValue: '@company/happier-cli', fallback: '@happier-dev/cli' }),
    '@company/happier-cli',
  );
  assert.equal(
    resolveNpmPackageNameOverride({ envValue: '../evil', fallback: '@happier-dev/cli' }),
    '@happier-dev/cli',
  );
  assert.equal(
    resolveNpmPackageNameOverride({ envValue: '@scope/../evil', fallback: '@happier-dev/cli' }),
    '@happier-dev/cli',
  );
  assert.equal(
    resolveNpmPackageNameOverride({ envValue: '', fallback: '@happier-dev/cli' }),
    '@happier-dev/cli',
  );
});

test('acquireSingleFlightLock prevents duplicate spawns until ttl expires', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-cli-common-lock-'));
  const lockPath = join(dir, 'update.check.lock.json');
  try {
    const pid = 12345;
    assert.equal(acquireSingleFlightLock({ lockPath, nowMs: 10_000, ttlMs: 60_000, pid }), true);
    assert.equal(acquireSingleFlightLock({ lockPath, nowMs: 10_100, ttlMs: 60_000, pid }), false);

    // After TTL, we should be able to acquire again.
    assert.equal(acquireSingleFlightLock({ lockPath, nowMs: 100_000, ttlMs: 60_000, pid }), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveSpawnDetachedNodeInvocation uses script when execPath is a JS runtime', () => {
  assert.deepEqual(
    resolveSpawnDetachedNodeInvocation({
      execPath: '/usr/bin/node',
      script: '/repo/apps/cli/dist/index.mjs',
      args: ['self', 'check', '--quiet'],
    }),
    { file: '/usr/bin/node', args: ['/repo/apps/cli/dist/index.mjs', 'self', 'check', '--quiet'], isRuntime: true },
  );
  assert.deepEqual(
    resolveSpawnDetachedNodeInvocation({
      execPath: '/usr/local/bin/bun',
      script: '/repo/apps/cli/dist/index.mjs',
      args: ['self', 'check', '--quiet'],
    }),
    { file: '/usr/local/bin/bun', args: ['/repo/apps/cli/dist/index.mjs', 'self', 'check', '--quiet'], isRuntime: true },
  );
});

test('resolveSpawnDetachedNodeInvocation omits script when execPath is a self-contained CLI binary', () => {
  assert.deepEqual(
    resolveSpawnDetachedNodeInvocation({
      execPath: '/home/user/.happier/bin/happier',
      script: '/$bunfs/dist/index.mjs',
      args: ['self', 'check', '--quiet'],
    }),
    { file: '/home/user/.happier/bin/happier', args: ['self', 'check', '--quiet'], isRuntime: false },
  );
});

test('readNpmDistTagVersion resolves npm.cmd shims on Windows', async () => {
  const fixture = await createWindowsNpmShimFixture();
  try {
    await withPlatform('win32', async () => {
      const version = readNpmDistTagVersion({
        packageName: '@happier-dev/cli',
        distTag: 'latest',
        cwd: fixture.dir,
        env: {
          PATH: fixture.binDir,
          PATHEXT: '.CMD;.EXE',
          ComSpec: 'cmd.exe',
        },
      });
      assert.equal(version, '1.2.3');
    });
  } finally {
    await fixture.cleanup();
  }
});

test('installRuntimeFromNpm resolves npm.cmd shims on Windows', async () => {
  const fixture = await createWindowsNpmShimFixture();
  try {
    await withPlatform('win32', async () => {
      const runtimeDir = join(fixture.dir, 'runtime');
      const result = installRuntimeFromNpm({
        runtimeDir,
        spec: '@happier-dev/cli@1.2.3',
        cwd: fixture.dir,
        env: {
          PATH: fixture.binDir,
          PATHEXT: '.CMD;.EXE',
          ComSpec: 'cmd.exe',
        },
      });
      assert.equal(result.ok, true);
    });
  } finally {
    await fixture.cleanup();
  }
});
