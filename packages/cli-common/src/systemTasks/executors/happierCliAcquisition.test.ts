import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readDesktopInstallations, readDesktopResourceOwnership, resolveFirstPartyInstallLayout, installVersionedPayload, resolveInstalledFirstPartyComponentPaths, writeHappierCliChoice } from '../../firstPartyRuntime/index.js';
import {
  DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES,
  createLocalHappierJsonExecutor,
  ensureLocalFirstPartyComponentCommand,
  resolveExplicitOrInstalledLocalFirstPartyCommand,
} from '../index.js';

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe('local command acquisition lifecycle', () => {
  it.each(['release', 'download', 'cancel'] as const)('preserves %s failure or cancellation through the executor', async (outcome) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'cli-common-acquisition-failure-'));
    const controller = new AbortController();
    let requests = 0;
    let baseUrl = '';
    const server = http.createServer((req, res) => {
      requests += 1;
      if (outcome === 'download' && req.url?.startsWith('/happier-dev/happier/releases/expanded_assets/')) {
        const os = process.platform === 'win32' ? 'windows' : process.platform;
        const archive = `happier-v0.3.0-${os}-${process.arch}.tar.gz`;
        const checksums = 'checksums-happier-v0.3.0.txt';
        res.end(`<ul>${[archive, checksums, `${checksums}.minisig`].map((name) => `<li><a href="/happier-dev/happier/releases/download/cli-stable/${name}">${name}</a><clipboard-copy value="sha256:${'a'.repeat(64)}"></clipboard-copy></li>`).join('')}</ul>`);
        return;
      }
      if (outcome === 'cancel' && requests === 1) controller.abort();
      res.writeHead(403).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture address');
    baseUrl = `http://127.0.0.1:${address.port}`;
    // Only the external HTTP boundary is redirected; acquisition and executor logic stay real.
    vi.spyOn(https, 'request').mockImplementation((url, options, callback) => {
      const parsed = new URL(String(url));
      if (parsed.hostname !== 'api.github.com' && parsed.hostname !== 'github.com') throw new Error(`Unexpected request: ${parsed.origin}`);
      return http.request(`http://127.0.0.1:${address.port}${parsed.pathname}`, options, callback);
    });
    syncBuiltinESMExports();
    const progress: unknown[] = [];
    try {
      const options = {
        processEnv: { HAPPIER_HOME_DIR: join(rootDir, 'home'), HAPPIER_STACK_REPO_DIR: rootDir },
        signal: outcome === 'cancel' ? undefined : controller.signal,
        onProgress: (event: Readonly<{ phase: string }>) => { progress.push(event); },
        onCommandReady: () => { progress.push({ phase: 'checkingDaemon' }); },
      };
      const executor = createLocalHappierJsonExecutor(options);
      const error: unknown = await executor.runHappierJson(['doctor', '--json'], { signal: controller.signal }).catch((error: unknown) => error);
      const phase = outcome === 'download' ? 'downloading' : 'resolvingRelease';
      expect(error).toMatchObject(outcome === 'cancel' ? { name: 'AbortError' } : { code: `cli_acquisition_${phase}_failed` });
      expect(progress).toContainEqual({ phase: 'resolvingRelease' });
      expect(progress).not.toContainEqual({ phase: 'checkingDaemon' });
      if (outcome !== 'cancel') {
        expect(progress).toContainEqual({ phase, failure: { cause: 'HTTP_403' } });
        expect(String(error)).toContain('403');
        expect(JSON.stringify({ message: String(error), progress })).not.toMatch(/fixture-secret|fixture-password/u);
      } else {
        expect(progress).toEqual([{ phase: 'resolvingRelease' }]);
        await expect(executor.runHappierJson(['doctor', '--json'])).rejects.toMatchObject({
          code: 'cli_acquisition_resolvingRelease_failed',
        });
        expect(requests).toBe(2);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('honors cancellation before attempting an explicit command', async () => {
    const controller = new AbortController();
    controller.abort();
    let commandReady = false;
    const options = {
      processEnv: { HAPPIER_BOOTSTRAP_CLI_PATH: '/missing-happier-command' },
      signal: controller.signal,
      onCommandReady: () => { commandReady = true; },
    };
    const executor = createLocalHappierJsonExecutor(options);
    await expect(executor.runHappierText(['--version'])).rejects.toMatchObject({ name: 'AbortError' });
    expect(commandReady).toBe(false);
  });

  it('reports command readiness before the resolved executable starts', async () => {
    const processEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HAPPIER_BOOTSTRAP_CLI_PATH: process.execPath,
      HAPPIER_TEST_COMMAND_PHASE: 'pending',
    };
    const options = {
      processEnv,
      onCommandReady: () => { processEnv.HAPPIER_TEST_COMMAND_PHASE = 'checkingDaemon'; },
    };
    const executor = createLocalHappierJsonExecutor(options);
    // Run a real process boundary so readiness must precede spawning the command.
    await expect(executor.runHappierJson([
      '-e', 'console.log(JSON.stringify({ phase: process.env.HAPPIER_TEST_COMMAND_PHASE }))',
    ])).resolves.toEqual({ phase: 'checkingDaemon' });
  });
});

describe('ensureLocalFirstPartyComponentCommand', () => {
  it('registers a Desktop consumer when reusing a managed CLI, while retaining its separate install home', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'cli-desktop-consumer-'));
    const processEnv = { ...process.env, HAPPIER_HOME_DIR: join(rootDir, 'runtime'), HAPPIER_FIRST_PARTY_INSTALL_HOME: join(rootDir, 'install'),
      HAPPIER_DESKTOP_BUNDLE_ID: 'dev.happier.app', HAPPIER_DESKTOP_STATE_DIR: join(rootDir, 'desktop'), HAPPIER_STACK_REPO_DIR: join(rootDir, 'no-repo') };
    const payloadRoot = join(rootDir, 'payload');
    mkdirSync(join(payloadRoot, 'package-dist'), { recursive: true });
    writeFileSync(join(payloadRoot, process.platform === 'win32' ? 'happier.exe' : 'happier'), 'cli');
    writeFileSync(join(payloadRoot, 'package-dist', 'index.mjs'), 'export {};');
    try {
      await installVersionedPayload({ componentId: 'happier-cli', versionId: '1.0.0', payloadRoot, processEnv, desktopBundleId: 'dev.happier.preview' });
      expect(resolveExplicitOrInstalledLocalFirstPartyCommand({ componentId: 'happier-cli', processEnv, releaseRing: 'stable' })?.provenance).toBe('managed');
      const command = await ensureLocalFirstPartyComponentCommand({ componentId: 'happier-cli', processEnv, releaseRing: 'stable' });
      const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv });
      expect((await readDesktopResourceOwnership(layout.installRoot))?.consumers).toEqual(['dev.happier.app', 'dev.happier.preview']);
      expect(await readDesktopInstallations({ bundleId: 'dev.happier.app', stateDir: processEnv.HAPPIER_DESKTOP_STATE_DIR })).toEqual([
        { happyHomeDir: processEnv.HAPPIER_HOME_DIR, firstPartyInstallHome: processEnv.HAPPIER_FIRST_PARTY_INSTALL_HOME, cliPath: command },
      ]);
    } finally { rmSync(rootDir, { recursive: true, force: true }); }
  });

  it('returns an explicit env-var command without attempting install', async () => {
    const preparePayload = vi.fn();
    const installPayload = vi.fn();

    await expect(ensureLocalFirstPartyComponentCommand(
      {
        componentId: 'happier-cli',
        processEnv: {
          ...process.env,
          [DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES[0]]: '/tmp/explicit-happier',
        },
        envVarNames: DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES,
        releaseRing: 'stable',
      },
      {
        preparePayload: preparePayload as never,
        installPayload: installPayload as never,
      },
    )).resolves.toBe('/tmp/explicit-happier');

    expect(preparePayload).not.toHaveBeenCalled();
    expect(installPayload).not.toHaveBeenCalled();
  });

  it('prepares and installs the component when no explicit/installed command exists', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'cli-common-cli-acquire-'));
    const happyHomeDir = join(rootDir, '.happier-home');
    const previousCwd = process.cwd();
    const preparePayload = vi.fn(async () => ({
      versionId: '1.2.3',
      payloadRoot: join(rootDir, 'payload'),
      cleanup: async () => undefined,
    }));

    const installPayload = vi.fn(async (params: Parameters<typeof import('../../firstPartyRuntime/index.js')['installVersionedPayload']>[0]) => {
      const paths = resolveInstalledFirstPartyComponentPaths({
        componentId: params.componentId,
        processEnv: params.processEnv,
        releaseRing: params.releaseRing,
      });
      mkdirSync(dirname(paths.binaryPath), { recursive: true });
      writeFileSync(paths.binaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      chmodSync(paths.binaryPath, 0o755);
    });

    try {
      process.chdir(rootDir);
      const command = await ensureLocalFirstPartyComponentCommand(
        {
          componentId: 'happier-cli',
          processEnv: {
            HAPPIER_HOME_DIR: happyHomeDir,
            HAPPIER_STACK_REPO_DIR: rootDir,
          },
          envVarNames: DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES,
          releaseRing: 'stable',
        },
        {
          preparePayload: preparePayload as never,
          installPayload: installPayload as never,
        },
      );

      const expected = resolveInstalledFirstPartyComponentPaths({
        componentId: 'happier-cli',
        processEnv: {
          HAPPIER_HOME_DIR: happyHomeDir,
          HAPPIER_STACK_REPO_DIR: rootDir,
        },
        releaseRing: 'stable',
      }).binaryPath;

      expect(command).toBe(expected);
      expect(preparePayload).toHaveBeenCalledTimes(1);
      expect(installPayload).toHaveBeenCalledTimes(1);
    } finally {
      process.chdir(previousCwd);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('resolveExplicitOrInstalledLocalFirstPartyCommand provenance', () => {
  it('refuses managed provenance for a binary planted under the install root with no install record', () => {
    // A local process can create `<installRoot>/current/<binary>` before anything was ever
    // acquired. Nothing verified it, so it must never be classified `managed`: the desktop
    // approval owner offers automatic pairing approval only to a managed CLI, and the approved
    // CLI goes on to claim its own account bearer from the Home.
    const rootDir = mkdtempSync(join(tmpdir(), 'cli-common-planted-binary-'));
    const happierHomeDir = join(rootDir, 'home');
    const plantedPath = join(happierHomeDir, 'cli', 'current', 'happier');

    try {
      mkdirSync(dirname(plantedPath), { recursive: true });
      writeFileSync(plantedPath, '#!/usr/bin/env node\n', 'utf8');
      chmodSync(plantedPath, 0o755);

      expect(resolveExplicitOrInstalledLocalFirstPartyCommand({
        componentId: 'happier-cli',
        releaseRing: 'stable',
        processEnv: {
          HAPPIER_HOME_DIR: happierHomeDir,
          HAPPIER_STACK_REPO_DIR: join(rootDir, 'elsewhere'),
        },
      })).toEqual({ command: plantedPath, provenance: 'override' });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('reports a real managed install as managed and env/repo commands as override', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'cli-common-provenance-'));
    const happierHomeDir = join(rootDir, 'home');
    const managedPath = join(happierHomeDir, 'cli', 'current', 'happier');
    const repoRoot = join(rootDir, 'repo');
    const repoPath = join(repoRoot, 'apps', 'cli', 'bin', 'happier.mjs');
    const envPath = join(rootDir, 'env-happier');
    const stagedPayloadRoot = join(rootDir, 'staged');

    try {
      for (const path of [repoPath, envPath]) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '#!/usr/bin/env node\n', 'utf8');
        chmodSync(path, 0o755);
      }

      // The real install path: it writes the payload under `versions/<versionId>` and records
      // `current.version` beside it. That record is what `managed` means.
      mkdirSync(stagedPayloadRoot, { recursive: true });
      writeFileSync(join(stagedPayloadRoot, 'happier'), '#!/usr/bin/env node\n', 'utf8');
      chmodSync(join(stagedPayloadRoot, 'happier'), 0o755);
      await installVersionedPayload({
        componentId: 'happier-cli',
        versionId: '0.3.0',
        payloadRoot: stagedPayloadRoot,
        releaseRing: 'stable',
        processEnv: { HAPPIER_HOME_DIR: happierHomeDir },
      });

      expect(resolveExplicitOrInstalledLocalFirstPartyCommand({
        componentId: 'happier-cli',
        releaseRing: 'stable',
        envVarNames: DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES,
        processEnv: {
          HAPPIER_HOME_DIR: happierHomeDir,
          HAPPIER_STACK_REPO_DIR: repoRoot,
          [DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES[0]]: envPath,
        },
      })).toEqual({ command: envPath, provenance: 'override' });

      expect(resolveExplicitOrInstalledLocalFirstPartyCommand({
        componentId: 'happier-cli',
        releaseRing: 'stable',
        processEnv: {
          HAPPIER_HOME_DIR: happierHomeDir,
          HAPPIER_STACK_REPO_DIR: repoRoot,
        },
      })).toEqual({ command: repoPath, provenance: 'override' });

      expect(resolveExplicitOrInstalledLocalFirstPartyCommand({
        componentId: 'happier-cli',
        releaseRing: 'stable',
        processEnv: {
          HAPPIER_HOME_DIR: happierHomeDir,
          HAPPIER_STACK_REPO_DIR: join(rootDir, 'elsewhere'),
        },
      })).toEqual({ command: managedPath, provenance: 'managed' });

      // The binary alone is not enough: with the install record removed the very same runnable
      // payload is `override`, because nothing here recorded an install that was verified.
      rmSync(join(happierHomeDir, 'cli', 'current.version'), { force: true });
      expect(resolveExplicitOrInstalledLocalFirstPartyCommand({
        componentId: 'happier-cli',
        releaseRing: 'stable',
        processEnv: {
          HAPPIER_HOME_DIR: happierHomeDir,
          HAPPIER_STACK_REPO_DIR: join(rootDir, 'elsewhere'),
        },
      })).toEqual({ command: managedPath, provenance: 'override' });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('resolves the one CLI this computer chose, and never acquires past a CLI the user installed (R12)', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'cli-common-cli-choice-'));
    const happierHomeDir = join(rootDir, 'home');
    const npmBin = join(rootDir, 'npm-global', 'bin');
    const npmHappier = join(npmBin, 'happier');
    const managedPath = join(happierHomeDir, 'cli', 'current', 'happier');
    const stagedPayloadRoot = join(rootDir, 'staged');
    const processEnv = { HAPPIER_HOME_DIR: happierHomeDir, HAPPIER_STACK_REPO_DIR: join(rootDir, 'elsewhere'), PATH: npmBin };
    const resolve = () => resolveExplicitOrInstalledLocalFirstPartyCommand({ componentId: 'happier-cli', releaseRing: 'stable', processEnv });

    try {
      mkdirSync(npmBin, { recursive: true });
      writeFileSync(npmHappier, '#!/bin/sh\n', 'utf8');
      chmodSync(npmHappier, 0o755);

      // Nobody was asked yet: the CLI a new terminal runs answers, so no read acquires a second one.
      expect(resolve()).toEqual({ command: npmHappier, provenance: 'override' });

      // "Let Happier manage it" with nothing installed yet: acquisition runs.
      await writeHappierCliChoice({ choice: { mode: 'managed' }, processEnv });
      expect(resolve()).toBeNull();

      mkdirSync(stagedPayloadRoot, { recursive: true });
      writeFileSync(join(stagedPayloadRoot, 'happier'), '#!/bin/sh\n', 'utf8');
      chmodSync(join(stagedPayloadRoot, 'happier'), 0o755);
      await installVersionedPayload({
        componentId: 'happier-cli',
        versionId: '0.3.0',
        payloadRoot: stagedPayloadRoot,
        releaseRing: 'stable',
        processEnv,
      });
      expect(resolve()).toEqual({ command: managedPath, provenance: 'managed' });

      // "Keep my own": that CLI wins even over a managed copy still on disk.
      await writeHappierCliChoice({ choice: { mode: 'own', command: npmHappier }, processEnv });
      expect(resolve()).toEqual({ command: npmHappier, provenance: 'override' });

      // The kept CLI disappeared (R13 b): still this computer's answer, so neither the managed copy
      // left on disk nor a fresh acquisition stands in for it — the question comes first.
      rmSync(npmHappier, { force: true });
      expect(resolve).toThrow(expect.objectContaining({ code: 'cli_choice_required', message: expect.stringContaining(npmHappier) }));
      await expect(ensureLocalFirstPartyComponentCommand(
        { componentId: 'happier-cli', releaseRing: 'stable', processEnv },
        { preparePayload: async () => { throw new Error('must not acquire'); } },
      )).rejects.toMatchObject({ code: 'cli_choice_required' });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
