import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bundleCliSourceSidecars,
  createWorkspaceSourceResolver,
  readWorkspacePackages,
  SOURCE_CONDITION,
  SOURCE_RUNTIME_COMMONJS_BANNER, SOURCE_RUNTIME_COMMONJS_DEFINE, SOURCE_RUNTIME_OUTPUT_OPTIONS,
} from '../../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { DEFAULT_MEMORY_SETTINGS } from '@/settings/memorySettings';

describe('compiled Memory process placement', () => {
  const env = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  let outputDir: string;
  let entryUrls: readonly (readonly [string, string])[];
  let processUrl: string;
  let workerUrl: string;
  let lazyImports: boolean[];

  beforeAll(async () => {
    // Emitted chunks keep host-visible dependencies bare (source-runtime resolver), so the
    // output must sit where Node resolves the installed tree, like the canonical layout.
    const cacheDir = fileURLToPath(new URL('../../../node_modules/.cache', import.meta.url));
    await mkdir(cacheDir, { recursive: true });
    outputDir = await createTempDir('happier-memory-bundle-', cacheDir);
    const home = join(outputDir, 'home');
    await mkdir(home);
    applyEnvValues({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://api.example.test', HAPPIER_WEBAPP_URL: 'https://app.example.test' });
      const repoDir = fileURLToPath(new URL('../../../../../', import.meta.url));
      const cliDir = join(repoDir, 'apps/cli');
      const workspacePackages = await readWorkspacePackages(repoDir);
      const requireFromProject = createRequire(join(cliDir, 'package.json'));
      const sources = {
        facade: fileURLToPath(new URL('./memoryWorker.ts', import.meta.url)),
        process: fileURLToPath(new URL('./processMemoryIndexer.ts', import.meta.url)),
        command: fileURLToPath(new URL('../../cli/commands/daemon.ts', import.meta.url)),
        child: fileURLToPath(new URL('./memoryIndexerServiceEntry.ts', import.meta.url)),
      };
      // Match the canonical source-runtime package-dist/chunks + scripts root
      // layout, retaining real external dependencies through its resolver.
      const result = await build({
        absWorkingDir: repoDir,
        entryPoints: { 'package-dist/facade': sources.facade, 'package-dist/command': sources.command },
        outdir: outputDir, bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node20',
        chunkNames: 'package-dist/chunks/[name]-[hash]',
        ...SOURCE_RUNTIME_OUTPUT_OPTIONS,
        conditions: [SOURCE_CONDITION], metafile: true, logLevel: 'silent',
        tsconfig: join(cliDir, 'tsconfig.json'),
        plugins: [createWorkspaceSourceResolver({ workspacePackages, requireFromProject })],
        banner: { js: SOURCE_RUNTIME_COMMONJS_BANNER },
        define: SOURCE_RUNTIME_COMMONJS_DEFINE,
      });
      await bundleCliSourceSidecars({ repoDir, outputDir: join(outputDir, 'scripts'), build,
        workspacePackages, requireFromProject });
      await writeFile(join(outputDir, 'package.json'), '{"type":"module"}');
      const outputFor = (source: string) => {
        const output = Object.entries(result.metafile.outputs).find(([, metadata]) =>
          metadata.entryPoint !== undefined && resolve(repoDir, metadata.entryPoint) === source);
        if (!output) throw new Error(`Missing compiled Memory entry: ${source}`);
        return { path: resolve(repoDir, output[0]), metadata: output[1] };
      };
      const facade = outputFor(sources.facade);
      const processOutput = outputFor(sources.process);
      const command = outputFor(sources.command);
      const child = outputFor(sources.child);
      const outputs = new Map(Object.entries(result.metafile.outputs).map(([path, metadata]) =>
        [resolve(repoDir, path), metadata]));
      const hasLazyImport = (from: string, target: string, seen = new Set<string>()): boolean => {
        if (seen.has(from)) return false;
        seen.add(from);
        return outputs.get(from)?.imports.some(edge => !edge.external && (edge.kind === 'dynamic-import'
          ? resolve(repoDir, edge.path) === target
          : hasLazyImport(resolve(repoDir, edge.path), target, seen))) ?? false;
      };
      lazyImports = [[facade, processOutput], [command, child]].map(([owner, target]) => hasLazyImport(owner.path, target.path));
      const entries = [
        [facade, 'startMemoryWorker'], [facade, 'prepareMemoryWorker'], [processOutput, 'connectProcessMemoryIndexer'],
        [command, 'handleDaemonCliCommand'], [child, 'runMemoryIndexerService'],
      ] as const;
      entryUrls = entries.map(([output, exported]) => [pathToFileURL(output.path).href, exported] as const);
      processUrl = pathToFileURL(processOutput.path).href;
      workerUrl = pathToFileURL(command.path).href;
  });

  afterAll(async () => {
    restoreEnvValues(env);
    if (outputDir) await removeTempDir(outputDir);
  });

  it('loads the named exports through the compiled lazy-import paths', async () => {
      expect(lazyImports).toEqual([true, true]);
      // Like controlHttp.bundledUndici, execute emitted exports outside the
      // Vitest VM. This probe imports only; it invokes no daemon/worker entry.
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        const callable = [];
        for (const [url, exported] of JSON.parse(process.argv[1])) {
          const loaded = await import(url);
          callable.push(typeof loaded[exported]);
        }
        process.stdout.write(JSON.stringify(callable));
      `, JSON.stringify(entryUrls)],
      { cwd: outputDir, encoding: 'utf8' });
      expect(JSON.parse(stdout)).toEqual(['function', 'function', 'function', 'function', 'function']);
  });

  it('exits real children after settlement and recovers crashes only on demand', async () => {
      // Run the emitted parent and worker across real OS pipes. This does not
      // start a daemon or depend on another lane's prepared CLI payload.
      const { stdout: lifecycleOutput } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        import { spawn } from 'node:child_process';
        const [parentUrl, workerUrl, settings] = JSON.parse(process.argv[1]);
        const { connectProcessMemoryIndexer } = await import(parentUrl);
        let births = 0;
        let exits = 0;
        let crashNext = false;
        const settled = [];
        const failures = [];
        const connectionOptions = {
          credentials: { token: 'fixture', encryption: null }, machineId: 'compiled-fixture',
          readSettings: () => settings,
          host: { publish() {}, failed(error) { failures.push(error.code); }, observeSessions: async ids => ids,
            readExternalSources: async () => ({ sources: [], configuredSourceKeys: [], changes: [] }),
            runHint: async () => { throw new Error('Unexpected hint'); }, commitHint: async () => {} },
          spawnChannel: async () => {
            births++;
            const child = spawn(process.execPath, ['--input-type=module', '-e',
              'const { handleDaemonCliCommand } = await import(process.argv[1]); await handleDaemonCliCommand({ args: ["daemon", "background-service-worker"] });', workerUrl],
              { stdio: ['pipe', 'pipe', 'inherit'] });
            child.stdin.on('error', () => {});
            const termination = new Promise((resolve, reject) => {
              child.once('error', reject);
              child.once('exit', (code, signal) => { exits++; resolve(signal
                ? { type: 'signaled', signal } : { type: 'exited', code }); });
            });
            if (crashNext) { crashNext = false; child.once('spawn', () => child.kill()); }
            return { pid: child.pid, send: frame => child.stdin.write(frame),
              onData: listener => child.stdout.on('data', listener), waitForTermination: () => termination,
              close: async () => { child.stdin.end(); await termination; },
              terminate: async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await termination; } };
          },
        };
        const connection = await connectProcessMemoryIndexer(connectionOptions);
        let beforeRetirement;
        let afterCrash;
        try {
          for (let index = 0; index < 3; index++) {
            await connection.removeSessions(['absent-' + index]);
            settled.push({ births, exits });
          }
          crashNext = true;
          try { await connection.removeSessions(['crashed']); throw new Error('Crash must reject demand'); }
          catch (error) { if (error.code !== 'background_service_process_exited') throw error; }
          await new Promise(resolve => setImmediate(resolve));
          afterCrash = { births, exits };
          await connection.removeSessions(['after-crash']);
          beforeRetirement = { births, exits };
        } finally { await connection.retire(); }
        const afterRetirement = { births, exits };
        let noteGrace;
        const graceEntered = new Promise(resolve => { noteGrace = resolve; });
        const graceConnection = await connectProcessMemoryIndexer({ ...connectionOptions,
          readSettings: () => ({ ...settings, enabled: true, indexMode: 'deep',
            embeddings: { ...settings.embeddings, mode: 'disabled' } }),
          host: { ...connectionOptions.host, publish(snapshot) {
            if (snapshot.worker.currentPhase === 'idle_grace') noteGrace();
          } },
        });
        let whileServing;
        try {
          await graceConnection.removeSessions(['absent-during-grace']);
          await graceEntered;
          await graceConnection.embedQuery('warm-query');
          whileServing = { births, exits };
        } finally { await graceConnection.retire(); }
        process.stdout.write(JSON.stringify({ settled, failures, afterCrash, beforeRetirement, afterRetirement,
          whileServing, afterGraceRetirement: { births, exits } }));
      `, JSON.stringify([processUrl, workerUrl,
        { ...DEFAULT_MEMORY_SETTINGS, enabled: false, deleteOnDisable: false }])],
      { cwd: outputDir, encoding: 'utf8' });
      const { failures, ...lifecycleCounts } = JSON.parse(lifecycleOutput);
      expect(failures).toContain('background_service_process_exited');
      expect(lifecycleCounts).toEqual({
        settled: [{ births: 1, exits: 1 }, { births: 2, exits: 2 }, { births: 3, exits: 3 }],
        afterCrash: { births: 4, exits: 4 }, beforeRetirement: { births: 5, exits: 5 }, afterRetirement: { births: 5, exits: 5 },
        whileServing: { births: 6, exits: 5 }, afterGraceRetirement: { births: 6, exits: 6 },
      });
  });
});
