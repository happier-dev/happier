import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { spawn, spawnSync, ChildProcess, type SpawnOptions } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { build } from 'esbuild';
import { createWorkspaceSourceResolver, packageNameOfSpecifier, readWorkspacePackages } from '@happier-dev/cli-common/sourceRuntimeEntries';
import { resolveInstalledRuntimePackage } from '@happier-dev/cli-common/workspaceRuntimeDependencies';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import { launchBorrowedTerminalProcess } from './borrowedTerminalProcess';
import { createTerminalLauncherFixture } from '@/testkit/process/terminalLauncher';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { isPidAlive, waitForProcessExit } from '@/testkit/process/spawn';
import { bindProcessLogger, Logger } from '@/ui/logger';
import { waitForCondition } from '@/testkit/async/waitFor';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';

describe('launchBorrowedTerminalProcess', () => {
  it('does not spawn when cancellation wins the awaited before-spawn admission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-borrowed-before-spawn-'));
    const controller = new AbortController();
    const launcher = createTerminalLauncherFixture();
    let starts = 0;
    let admitted = false;
    try {
      const result = launchBorrowedTerminalProcess({
        spawnArgv: ['/native/agent'], workingDirectory: directory, spawnEnv: {}, signal: controller.signal,
        beforeSpawn: async () => { admitted = true; controller.abort(); },
        spawnProcess: (...args) => { starts += 1; return launcher.spawnProcess(...args); },
      });
      // Observe both outcomes before cleanup; a post-await cancellation check
      // must prevent reaching the actual OS-spawn adapter altogether.
      const settled = await result.then(async process => {
        launcher.child.emit('exit', 0, null);
        launcher.child.emit('disconnect');
        await process.whenExited;
        return 'spawned' as const;
      }, () => 'refused' as const);
      expect({ admitted, starts, settled }).toEqual({ admitted: true, starts: 0, settled: 'refused' });
    } finally {
      launcher.child.emit('exit', 0, null);
      launcher.child.emit('disconnect');
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['closed', 'empty'] as const)('drains private IPC before deciding native closure proof (%s)', async (proof) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-borrowed-exit-drain-'));
    // The OS child boundary deliberately delivers its IPC packet after its exit event.
    const launcher = createTerminalLauncherFixture();
    const child = Object.assign(launcher.child, { connected: true });
    let completePhysicalStop!: () => void;
    const physicalStop = new Promise<void>((resolve) => { completePhysicalStop = resolve; });
    const launched = await launchBorrowedTerminalProcess({
      spawnArgv: ['/native/agent'], workingDirectory: directory, spawnEnv: {},
      spawnProcess: launcher.spawnProcess,
      terminateProcess: async () => await physicalStop,
    });
    try {
      const stopping = launched.terminate();
      let settled = false;
      void launched.whenExited.then(() => { settled = true; });
      child.emit('exit', 0, null);
      await Promise.resolve();
      expect(settled).toBe(false);
      child.emit('message', { type: 'terminal-native-exited', code: proof === 'closed' ? 0 : null, signal: null });
      child.emit('disconnect');
      await Promise.resolve();
      expect(settled).toBe(false);
      completePhysicalStop();
      await stopping;
      const result = await launched.whenExited;
      expect(result).toMatchObject({ code: 0, signal: null });
      if (proof === 'closed') expect(result).toHaveProperty('nativeExited', true);
      else expect(result).not.toHaveProperty('nativeExited');
    } finally {
      completePhysicalStop();
      child.emit('disconnect');
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps wrapper SIGKILL separate from a still-live native provider', async () => {
    if (process.platform === 'win32') return; // The OS signal distinction is POSIX-specific.
    const directory = await mkdtemp(join(tmpdir(), 'happier-borrowed-wrapper-exit-'));
    const pidPath = join(directory, 'native.pid');
    let launcher: ChildProcess | undefined;
    let nativePid: number | undefined;
    let launched: Awaited<ReturnType<typeof launchBorrowedTerminalProcess>> | undefined;
    try {
      launched = await launchBorrowedTerminalProcess({
        spawnArgv: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', pidPath],
        workingDirectory: directory,
        spawnEnv: { PATH: process.env.PATH ?? '' },
        spawnProcess: (command, args, options) => {
          launcher = spawn(command, [...args], options); // Real OS boundary; preserve the production IPC path.
          return launcher;
        },
      });
      await waitForCondition(() => existsSync(pidPath), { timeoutMs: 10_000, label: 'native provider startup' });
      nativePid = Number(await readFile(pidPath, 'utf8'));
      launcher!.kill('SIGKILL');
      const result = await launched.whenExited;
      expect(result).toMatchObject({ code: null, signal: 'SIGKILL' });
      expect(result).not.toHaveProperty('nativeExited');
      expect(isPidAlive(nativePid)).toBe(true);
    } finally {
      if (!nativePid && existsSync(pidPath)) nativePid = Number(await readFile(pidPath, 'utf8'));
      if (nativePid) await terminateProcessTree({ pid: nativePid });
      if (launcher?.pid && isPidAlive(launcher.pid)) await terminateProcessTree(launcher);
      await launched?.whenExited.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('exposes the actual launcher process generation only after native startup admission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-launcher-custody-'));
    let launcherPid: number | undefined;
    let launched: Awaited<ReturnType<typeof launchBorrowedTerminalProcess>> | undefined;
    try {
      launched = await launchBorrowedTerminalProcess({
        spawnArgv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        workingDirectory: directory,
        spawnEnv: { PATH: process.env.PATH ?? '' },
        spawnProcess: (command, args, options) => {
          const child = spawn(command, [...args], options); // Actual OS spawn, preserving native IPC admission.
          launcherPid = child.pid;
          return child;
        },
      });
      expect(launcherPid).toBeGreaterThan(1);
      expect(launched.launcherIdentity).toEqual({
        pid: launcherPid,
        processInstanceFingerprint: readProcessInstanceFingerprintSync(launcherPid!),
      });
      expect(launched.launcherIdentity?.processInstanceFingerprint).toBeTruthy();
      expect(Object.isFrozen(launched.launcherIdentity)).toBe(true);
    } finally {
      if (launcherPid) await terminateProcessTree({ pid: launcherPid });
      await launched?.whenExited.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('retries failed physical termination while coalescing each attempt and retaining successful completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-termination-retry-'));
    const failure = new Error('physical termination temporarily unavailable');
    let rejectFirst!: (error: Error) => void;
    const firstBoundary = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    let releaseSecond!: () => void;
    const secondBoundary = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let attempts = 0;
    let launcherPid: number | undefined;
    let launched: Awaited<ReturnType<typeof launchBorrowedTerminalProcess>> | undefined;
    try {
      launched = await launchBorrowedTerminalProcess({
        spawnArgv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        workingDirectory: directory, spawnEnv: { PATH: process.env.PATH ?? '' },
        terminateProcess: async (child) => {
          launcherPid = child.pid;
          attempts += 1;
          if (attempts === 1) return firstBoundary;
          await secondBoundary;
          await terminateProcessTree(child);
        },
      });
      const first = launched.terminate();
      expect(launched.terminate()).toBe(first);
      const failureObserved = expect(first).rejects.toBe(failure);
      rejectFirst(failure);
      await failureObserved;
      expect(isPidAlive(launcherPid!)).toBe(true);
      const retry = launched.terminate();
      expect(launched.terminate()).toBe(retry);
      releaseSecond();
      await expect(retry).resolves.toBeUndefined();
      await expect(waitForProcessExit(launcherPid!, { timeoutMs: 3_000 })).resolves.toBe(true);
      await launched.whenExited;
      expect(launched.terminate()).toBe(retry);
      expect(attempts).toBe(2);
    } finally {
      releaseSecond();
      if (launcherPid) await terminateProcessTree({ pid: launcherPid });
      await launched?.whenExited.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('reports late handoff cleanup failure to the default file diagnostic without disturbing the terminal', async () => {
    if (process.platform === 'win32') return; // Real POSIX directory permissions.
    const directory = await mkdtemp(join(tmpdir(), 'happier-borrowed-diagnostic-'));
    const logPath = join(directory, 'diagnostic.log');
    const scopedLogger = new Logger({ logFilePath: logPath, allowDangerousRemoteLogging: false, pruneCurrentProcessLogs: false });
    const restoreLogger = bindProcessLogger(scopedLogger);
    const child = new ChildProcess();
    let specPath: string | undefined;
    const spawnProcess = vi.fn((_command: string, args: readonly string[], _options: SpawnOptions) => {
      specPath = args[1]!;
      queueMicrotask(() => child.emit('message', { type: 'terminal-native-spawned' }));
      return child; // Genuine OS-spawn/exit boundary.
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const launched = await launchBorrowedTerminalProcess({
        spawnArgv: ['/native/agent', 'private-native-argument'], workingDirectory: tmpdir(),
        spawnEnv: { PRIVATE_NATIVE_SECRET: 'private-native-value' }, spawnProcess,
      });
      chmodSync(dirname(specPath!), 0o500);
      child.emit('exit', 0, null);
      await expect(launched.whenExited).rejects.toMatchObject({ errors: expect.arrayContaining([
        expect.objectContaining({ code: 'EACCES' }),
        expect.objectContaining({ code: 'ENOTEMPTY' }),
      ]) });
      scopedLogger.flushSync();
      const diagnostic = await readFile(logPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      expect(diagnostic).toContain('terminal_child_completion_failed');
      expect(diagnostic).not.toContain('private-native');
      expect(diagnostic).not.toContain(specPath!);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      restoreLogger();
      if (specPath) {
        chmodSync(dirname(specPath), 0o700);
        await rm(dirname(specPath), { recursive: true, force: true });
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['sync', 'error-event'] as const)('preserves startup failure when private handoff cleanup also fails (%s)', async (failureMode) => {
    if (process.platform === 'win32') return; // Real POSIX directory permissions, not an internal mock.
    const failure = new Error('native spawn refused');
    let specPath: string | undefined;
    const child = new ChildProcess();
    const spawnProcess = vi.fn((_command: string, args: readonly string[], _options: SpawnOptions): ChildProcess => {
      specPath = args[1]!;
      chmodSync(dirname(specPath), 0o500);
      if (failureMode === 'sync') throw failure;
      queueMicrotask(() => child.emit('error', failure));
      return child; // Genuine failed OS-spawn boundary.
    });
    try {
      const result = launchBorrowedTerminalProcess({
        spawnArgv: ['/missing/native-agent'], workingDirectory: tmpdir(), spawnEnv: {}, spawnProcess,
      });
      const error = await result.catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AggregateError);
      const errors = (error as AggregateError).errors as unknown[];
      expect(errors).toContain(failure);
      expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ errors: expect.arrayContaining([
        expect.objectContaining({ code: 'EACCES' }),
        expect.objectContaining({ code: 'ENOTEMPTY' }),
      ]) })]));
    } finally {
      if (specPath) {
        chmodSync(dirname(specPath), 0o700);
        await rm(dirname(specPath), { recursive: true, force: true });
      }
    }
  });

  const bunProbe = spawnSync('bun', ['-p', 'process.execPath'], { encoding: 'utf8' });
  const bunPath = bunProbe.status === 0 ? bunProbe.stdout.trim() : null;
  describe('controller lifetime', () => {
    let assetsDirectory: string;
    let runnerPath: string;
    let borrowedControllerUrl: string;
    let attachControllerUrl: string;
    let fixtureHelperPath: string | undefined;
    beforeAll(async () => {
      // All runtime pairs consume the same read-only current-source assets;
      // each case owns its controller and native process tree.
      assetsDirectory = await mkdtemp(join(tmpdir(), 'happier-borrowed-assets-'));
      const scriptsDirectory = join(assetsDirectory, 'scripts');
      await mkdir(scriptsDirectory);
      for (const filename of ['terminal_launch_spec_runner.cjs', 'process_tree.cjs', 'native_process_exit.cjs']) {
        await cp(resolve('scripts', filename), join(scriptsDirectory, filename));
      }
      const nodeModulesDirectory = join(assetsDirectory, 'node_modules');
      await writeFile(join(assetsDirectory, 'package.json'), JSON.stringify({
        type: 'module', imports: { '#process-census': './src/process-census.mjs' },
      }));
      await mkdir(join(assetsDirectory, 'src'));
      // These OS lifetime tests consume current owner logic, independently of the development TS loader.
      const repoRoot = resolve('../..');
      const workspacePackages = await readWorkspacePackages(repoRoot);
      const fixtureBuild = await build({
        entryPoints: {
          'process-census': resolve('src/processes/census/processCensus.ts'),
          'borrowed-controller': resolve('src/terminal/host/borrowedTerminalProcess.ts'),
          'attach-controller': resolve('src/session/attach/providerCliAttach.ts'),
        },
        outdir: join(assetsDirectory, 'src'), outExtension: { '.js': '.mjs' },
        bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true,
        banner: { js: "import { createRequire as fixtureCreateRequire } from 'node:module'; const require = fixtureCreateRequire(import.meta.url);" },
        external: ['#process-census'], alias: { '@': resolve('src') },
        plugins: [createWorkspaceSourceResolver({ workspacePackages, requireFromProject: createRequire(resolve('package.json')) })],
      });
      borrowedControllerUrl = pathToFileURL(join(assetsDirectory, 'src', 'borrowed-controller.mjs')).href;
      attachControllerUrl = pathToFileURL(join(assetsDirectory, 'src', 'attach-controller.mjs')).href;
      if (process.platform === 'darwin' || process.platform === 'win32') {
        const helper = resolveProcessCustodySupportExecutable();
        if (!helper) throw new Error('Native process census helper must be staged before the source lifetime fixture');
        const supportDirectory = join(assetsDirectory, 'tools', 'unpacked');
        await mkdir(supportDirectory, { recursive: true });
        fixtureHelperPath = join(supportDirectory, basename(helper));
        await cp(helper, fixtureHelperPath);
      }
      // Resolve the emitted dependencies from the actual CLI installation, including
      // package-local dependencies. The raw cleanup sidecar also consumes cli-common.
      if (!fixtureBuild.metafile) throw new Error('The fixture build did not return its runtime import graph');
      const dependencyNames = new Set(['@happier-dev/cli-common', ...Object.values(fixtureBuild.metafile.outputs)
        .flatMap(output => output.imports)
        .filter(entry => entry.external && !isBuiltin(entry.path) && !entry.path.startsWith('#'))
        .map(entry => packageNameOfSpecifier(entry.path))]);
      await Promise.all([...dependencyNames].map(async packageName => {
        const installed = resolveInstalledRuntimePackage({
          packageName, resolveFromPackageJsonPath: resolve('package.json'), dereferenceRootDir: repoRoot,
        });
        const linkPath = join(nodeModulesDirectory, ...packageName.split('/'));
        await mkdir(dirname(linkPath), { recursive: true });
        await symlink(installed.packageDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      }));
      // Validate with a real Node reader: Vitest's resolver can reach packages outside the fixture.
      const processOwnerUrl = pathToFileURL(createRequire(join(assetsDirectory, 'package.json')).resolve('@happier-dev/cli-common/process')).href;
      const censusUrl = pathToFileURL(join(assetsDirectory, 'src', 'process-census.mjs')).href;
      const closureAdmission = spawnSync(process.execPath, ['--input-type=module', '-e', `
        await import(${JSON.stringify(processOwnerUrl)});
        const census = await import(${JSON.stringify(censusUrl)});
        const snapshot = await census.readProcessCensus({ freshness: 'fresh', pids: [process.pid], fields: [] });
        if (snapshot.status !== 'ok') throw new Error('Source lifetime census unavailable: ' + snapshot.reason);
      `], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
      expect(closureAdmission.status, closureAdmission.stderr).toBe(0);
      runnerPath = join(scriptsDirectory, 'terminal_launch_spec_runner.cjs');
    });
    afterAll(async () => {
      if (assetsDirectory) await rm(assetsDirectory, { recursive: true, force: true });
    });
    it('cancels during the real private handoff read without spawning a native child', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'happier-borrowed-read-cancel-'));
      const readingPath = join(directory, 'reading');
      const nativePath = join(directory, 'native-started');
      const preloadPath = join(directory, 'pause-handoff.cjs');
      // Pause only the launcher's real filesystem boundary, preserving its lifetime owner.
      await writeFile(preloadPath, `
        const fs = require('node:fs');
        const original = fs.promises.readFile;
        fs.promises.readFile = async (...args) => {
          fs.writeFileSync(${JSON.stringify(readingPath)}, 'reading');
          await new Promise(resolve => process.once('disconnect', resolve));
          return await original(...args);
        };
      `);
      const cancellation = new AbortController();
      let launcher: ChildProcess | undefined;
      const startup = launchBorrowedTerminalProcess({
        spawnArgv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(nativePath)}, 'started')`],
        spawnEnv: { PATH: process.env.PATH ?? '' }, workingDirectory: directory, signal: cancellation.signal,
        spawnProcess: (_command, args, options) => {
          const child = spawn(process.execPath, ['--require', preloadPath, runnerPath, ...args.slice(1)], options);
          launcher = child;
          return child;
        },
      });
      void startup.catch(() => undefined);
      try {
        await waitForCondition(() => existsSync(readingPath), { timeoutMs: 10_000, label: 'launch handoff read' });
        cancellation.abort();
        await expect(startup).rejects.toThrow();
        expect(existsSync(nativePath)).toBe(false);
        await expect(waitForProcessExit(launcher!.pid!, { timeoutMs: 10_000 })).resolves.toBe(true);
      } finally {
        cancellation.abort();
        if (launcher?.pid && isPidAlive(launcher.pid)) await terminateProcessTree(launcher);
        await startup.catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    });
    it('reports controller-loss cleanup failure with a fixed diagnostic, without native launch values', async () => {
      if (process.platform !== 'darwin') return; // Real native-helper denial, isolated to this copied fixture.
      const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-guardian-'));
      const pidPath = join(directory, 'native.pid');
      const mod = createRequire(import.meta.url)(runnerPath) as {
        runLaunchSpec: (spec: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }, signal: AbortSignal) => Promise<number>;
      };
      const controller = new AbortController();
      const previousPath = process.env.PATH;
      const withheldHelperPath = `${fixtureHelperPath!}.withheld`;
      let helperWithheld = false;
      let ownedPid: number | undefined;
      let diagnostic = '';
      const consoleError = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
        diagnostic += values.map(String).join(' ') + '\n';
      });
      let cleanupPromise: Promise<void> | undefined;
      const cleanup = () => cleanupPromise ??= (async () => {
        if (helperWithheld) {
          await rename(withheldHelperPath, fixtureHelperPath!);
          helperWithheld = false;
        }
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        consoleError.mockRestore();
        if (!ownedPid && existsSync(pidPath)) ownedPid = Number(readFileSync(pidPath, 'utf8'));
        if (ownedPid) {
          try { process.kill(ownedPid, 'SIGKILL'); } catch { /* already gone */ }
        }
        await rm(directory, { recursive: true, force: true });
      })();
      onTestFinished(cleanup);
      try {
        const native = mod.runLaunchSpec({
          command: process.execPath,
          args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', pidPath, 'private-native-value'],
          cwd: directory,
          env: { ...process.env, PRIVATE_NATIVE_VALUE: 'private-native-value' },
        }, controller.signal);
        await waitForCondition(() => existsSync(pidPath), { timeoutMs: 10_000, label: 'native guardian fixture startup' });
        ownedPid = Number(readFileSync(pidPath, 'utf8'));
        await rename(fixtureHelperPath!, withheldHelperPath);
        helperWithheld = true;
        // Native discovery uses the absolute copied helper; PATH alone only denies signal utilities.
        process.env.PATH = '';
        controller.abort();
        await native;
        expect(diagnostic).toContain('terminal_controller_cleanup_incomplete');
        expect(diagnostic).not.toContain('private-native-value');
        expect(diagnostic).not.toContain(pidPath);
      } finally { await cleanup(); }
    });

    it.each([
      { controllerRuntime: process.execPath, launcherRuntime: process.execPath, lifetime: true },
      ...(bunPath ? [
        { controllerRuntime: bunPath, launcherRuntime: process.execPath, lifetime: true },
        { controllerRuntime: process.execPath, launcherRuntime: bunPath, lifetime: true },
        { controllerRuntime: bunPath, launcherRuntime: bunPath, lifetime: true },
      ] : []),
      { controllerRuntime: process.execPath, launcherRuntime: process.execPath, lifetime: false },
      { controllerRuntime: process.execPath, launcherRuntime: process.execPath, lifetime: true, nativeAttach: true },
      { controllerRuntime: process.execPath, launcherRuntime: process.execPath, lifetime: true, nativeAttach: true, forcedDetach: true },
    ])('handles controller loss with controller=$controllerRuntime launcher=$launcherRuntime lifetime=$lifetime nativeAttach=$nativeAttach forcedDetach=$forcedDetach, preserving shell and final native environment', async ({ controllerRuntime, launcherRuntime, lifetime, nativeAttach, forcedDetach }) => {
      if (process.platform === 'win32') return; // This controller-only SIGKILL proof is POSIX-specific.
      const directory = await mkdtemp(join(tmpdir(), 'happier-borrowed-lifetime-'));
      const readyPath = join(directory, 'ready.json');
      const ownerUrl = borrowedControllerUrl;
      const descendant = 'process.send(process.pid); setInterval(() => {}, 1000);';
      const provider = `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        child.once('message', pid => require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ launcher: process.ppid, provider: process.pid, descendant: pid, env: { TEST_SECRET: process.env.TEST_SECRET, HERDR_ENV: process.env.HERDR_ENV } })));
        process.on('SIGTERM', () => { child.once('exit', () => process.exit(0)); child.kill('SIGTERM'); });
        ${forcedDetach ? "process.on('SIGINT', () => {});" : ''}
        setInterval(() => {}, 1000);
      `;
      const source = nativeAttach ? `
        const { createProviderCliAttachSurface } = await import(${JSON.stringify(attachControllerUrl)});
        const { spawn } = await import('node:child_process');
        const cancellation = new AbortController();
        process.on('message', message => { if (message === 'force-detach') { process.send('detach-request-observed'); cancellation.abort(); } });
        process.send('source-owner-ready');
        ${forcedDetach ? "const independentService = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); independentService.once('spawn', () => process.send({ type: 'independent-service-ready', pid: independentService.pid }));" : ''}
        const surface = createProviderCliAttachSurface({ agentId: 'opencode',
          resolveTarget: () => ({ ok: true, value: {} }), createArgs: () => [],
          resolveLaunchSpec: () => ({ source: 'managed', resolvedPath: ${JSON.stringify(process.execPath)}, command: ${JSON.stringify(process.execPath)}, args: ['-e', ${JSON.stringify(provider)}] }),
          env: { PATH: process.env.PATH, TEST_SECRET: 'private-native-value' },
          spawnProcess: (command, args, options) => spawn(command, args[0]?.endsWith('terminal_launch_spec_runner.cjs') ? [${JSON.stringify(runnerPath)}, ...args.slice(1)] : args, options),
        });
        await surface.attachManaged({ sessionId: 'harmless-fixture', metadata: { path: ${JSON.stringify(directory)} }, signal: cancellation.signal, onAttached: async () => { process.send('native-attach-ready'); } });
        ${forcedDetach ? "process.send('native-attach-finished'); setInterval(() => {}, 1000);" : ''}
      ` : lifetime ? `
        const { launchBorrowedTerminalProcess } = await import(${JSON.stringify(ownerUrl)});
        const { spawn } = await import('node:child_process');
        process.send('source-owner-ready');
        const launched = await launchBorrowedTerminalProcess({ spawnArgv: [${JSON.stringify(process.execPath)}, '-e', ${JSON.stringify(provider)}], spawnEnv: { PATH: process.env.PATH, TEST_SECRET: 'private-native-value' }, workingDirectory: ${JSON.stringify(directory)},
          spawnProcess: (command, args, options) => {
            return spawn(command, [${JSON.stringify(runnerPath)}, ...args.slice(1)], options);
          } });
        await launched.whenExited;
      ` : `
        const { spawn } = await import('node:child_process');
        process.send('source-owner-ready');
        const launcher = spawn(${JSON.stringify(launcherRuntime)}, [${JSON.stringify(runnerPath)}, ${JSON.stringify(join(directory, 'launch.json'))}], { stdio: 'ignore' });
        await new Promise(resolve => launcher.once('exit', resolve));
      `;
      if (!lifetime) await writeFile(join(directory, 'launch.json'), JSON.stringify({
        command: process.execPath, args: ['-e', provider], cwd: directory,
        env: { PATH: process.env.PATH ?? '', TEST_SECRET: 'private-native-value' },
      }));
      const controllerArgs = controllerRuntime === bunPath ? ['-e', source] : ['--input-type=module', '-e', source];
      const controller = spawn(controllerRuntime, controllerArgs, {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        serialization: 'json',
        env: { ...process.env, NODE_PATH: '', HERDR_ENV: 'must-not-return', HAPPIER_JS_RUNTIME_PATH: launcherRuntime },
      });
      // Only the owned launcher/provider inherit this stderr pipe. 'exit' reports
      // controller death; 'close' waits for their runner to finish its cleanup.
      const controllerClosed = new Promise<void>(resolve => controller.once('close', () => resolve()));
      const attachmentFinished = new Promise<void>(resolve => controller.on('message', message => {
        if (message === 'native-attach-finished') resolve();
      }));
      let stderr = '';
      const observations: unknown[] = [];
      let independentServicePid: number | undefined;
      controller.on('message', (message) => {
        observations.push(message);
        if (message && typeof message === 'object' && 'type' in message && message.type === 'independent-service-ready'
          && 'pid' in message && typeof message.pid === 'number') independentServicePid = message.pid;
      });
      controller.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      let phase = 'current-source controller import';
      onTestFailed(() => {
        console.error(`Controller lifetime fixture failed during ${phase}; exit=${controller.exitCode}; observations=${JSON.stringify(observations)}; stderr=${stderr}`);
      });
      const sourceReady = new Promise<void>((resolve, reject) => {
        controller.once('message', (message) => {
          if (message === 'source-owner-ready') resolve();
          else reject(new Error('Controller emitted an unexpected readiness phase'));
        });
        controller.once('error', reject);
        controller.once('exit', () => reject(new Error(`Source controller exited before readiness: ${stderr}`)));
      });
      const sentinel = spawn('/bin/sh', ['-c', 'sleep 600'], { stdio: 'ignore' });
      let tree: { launcher: number; provider: number; descendant: number; env: Record<string, string> } | undefined;
      let cleanup: Promise<void> | undefined;
      const cleanOwnedProcesses = () => cleanup ??= (async () => {
        if (tree && isPidAlive(tree.launcher)) await terminateProcessTree({ pid: tree.launcher });
        else if (tree && isPidAlive(tree.provider)) await terminateProcessTree({ pid: tree.provider });
        if (tree && isPidAlive(tree.descendant)) await terminateProcessTree({ pid: tree.descendant });
        if (independentServicePid && isPidAlive(independentServicePid)) await terminateProcessTree({ pid: independentServicePid });
        if (controller.exitCode === null && controller.signalCode === null) await terminateProcessTree(controller);
        await terminateProcessTree(sentinel);
        await rm(directory, { recursive: true, force: true });
      })();
      onTestFinished(cleanOwnedProcesses);
      try {
        // Cold author-source imports belong to the unchanged overall test budget,
        // not the native process readiness phase. The test hook also cleans a timed-out import.
        await sourceReady;
        phase = 'native provider readiness';
        await vi.waitFor(async () => {
          try { tree = JSON.parse(await readFile(readyPath, 'utf8')); }
          catch (error) { throw new Error(`Native process not ready (exit=${controller.exitCode}; stderr=${stderr})`, { cause: error }); }
        }, { timeout: 10_000 });
        expect(tree!.env).toEqual({ TEST_SECRET: 'private-native-value' });
        expect(isPidAlive(tree!.descendant)).toBe(true);
        phase = forcedDetach ? 'forced native detach and owned tree cleanup' : 'controller-only SIGKILL and owned tree cleanup';
        if (forcedDetach) {
          await vi.waitFor(() => expect(observations).toContain('native-attach-ready'), { timeout: 10_000 });
          controller.send('force-detach');
          await vi.waitFor(() => expect(observations).toContain('detach-request-observed'), { timeout: 10_000 });
        }
        else {
          controller.kill('SIGKILL');
          await expect(waitForProcessExit(controller.pid!, { timeoutMs: 10_000 })).resolves.toBe(true);
        }
        if (lifetime) {
          // The owner's grace budget begins after discovery and signal checks;
          // the unchanged whole-test budget bounds this actual completion wait.
          if (forcedDetach) await attachmentFinished;
          else await controllerClosed;
          expect(isPidAlive(tree!.provider)).toBe(false);
          expect(isPidAlive(tree!.descendant)).toBe(false);
        } else {
          await expect(waitForProcessExit(tree!.provider, { timeoutMs: 3_000 })).resolves.toBe(false);
          expect(isPidAlive(tree!.descendant)).toBe(true);
        }
        expect(isPidAlive(sentinel.pid!)).toBe(true);
        if (forcedDetach) expect(isPidAlive(controller.pid!)).toBe(true);
        if (forcedDetach) {
          expect(independentServicePid).toBeTypeOf('number');
          expect(isPidAlive(independentServicePid!)).toBe(true);
        }
        phase = 'fixture teardown';
      } finally {
        await cleanOwnedProcesses();
      }
    });
  });

  it.each([process.execPath, ...(bunPath ? [bunPath] : [])])('observes normal native close without ending its controller or retaining a private handoff (launcher=%s)', async (launcherRuntime) => {
    const launched = await launchBorrowedTerminalProcess({
      spawnArgv: [process.execPath, '-e', 'process.exit(0)'],
      spawnEnv: {}, workingDirectory: tmpdir(),
      spawnProcess: (_command, args, options) => spawn(launcherRuntime, [...args], options),
    });
    await expect(launched.whenExited).resolves.toEqual({ code: 0, signal: null, nativeExited: true });
  });

  it('does not acknowledge a successfully spawned launcher when the native executable is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-borrowed-missing-'));
    try {
      const result = launchBorrowedTerminalProcess({
        spawnArgv: [join(directory, 'missing-native-executable')], spawnEnv: {}, workingDirectory: directory,
      });
      await expect(result).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('runs the launch argv in the current terminal and terminates only its process tree', async () => {
    const child = Object.assign(new ChildProcess(), { pid: 42 });
    const spawnProcess = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => {
      queueMicrotask(() => child.emit('message', { type: 'terminal-native-spawned' }));
      return child;
    });
    const terminateProcess = vi.fn(async () => undefined);

    const launched = await launchBorrowedTerminalProcess({
      spawnArgv: ['/managed/agent', 'opaque arg'],
      spawnEnv: { PATH: '/bin', TERM: 'xterm-256color' },
      workingDirectory: '/workspace/project',
      spawnProcess,
      terminateProcess,
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      expect.any(String),
      [expect.stringContaining('terminal_launch_spec_runner.cjs'), expect.any(String)],
      expect.objectContaining({
        cwd: '/workspace/project',
        env: { PATH: '/bin', TERM: 'xterm-256color' },
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      }),
    );

    const specPath = spawnProcess.mock.calls[0]![1]![1] as string;
    expect(JSON.parse(await readFile(specPath, 'utf8'))).toMatchObject({
      command: '/managed/agent', args: ['opaque arg'],
      env: { PATH: '/bin', TERM: 'xterm-256color' },
      envPassthroughKeys: ['TERM', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION'],
    });

    child.emit('exit', 0, null);
    await expect(launched.whenExited).resolves.toEqual({ code: 0, signal: null });
    await expect(readFile(specPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await launched.terminate();
    await launched.terminate();
    expect(terminateProcess).toHaveBeenCalledOnce();
    expect(terminateProcess).toHaveBeenCalledWith(child);
  });

  it('reports a spawn failure through startup without leaking an unhandled exit rejection', async () => {
    const child = new ChildProcess();
    const failure = new Error('spawn failed');
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('error', failure));
      return child;
    });

    await expect(launchBorrowedTerminalProcess({
      spawnArgv: ['/missing/managed-node'],
      spawnEnv: { PATH: '/bin' },
      workingDirectory: '/workspace/project',
      spawnProcess,
    })).rejects.toBe(failure);
  });
});
