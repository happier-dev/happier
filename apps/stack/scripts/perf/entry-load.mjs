import { createRequire } from 'node:module';
import { realpathSync, writeSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeRuntimeImport } from '../utils/proc/runtimeImportProbe.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const self = fileURLToPath(import.meta.url);
const preload = join(repo, 'packages/cli-common/registerSourceRuntime.mjs');

// Source imports use the same entry owners as the existing per-package probes.
// UI needs its canonical native-platform boundary harness; SDK needs browser
// bundling/evaluation rather than Node's different export conditions.
export const ENTRY_GRAPHS = Object.freeze([
  { id: 'daemon-entry-preparation', entry: 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', cwd: 'apps/cli', tsconfig: 'apps/cli/tsconfig.runtime.json' },
  { id: 'daemon', entry: 'apps/cli/src/daemon/startDaemon.ts', cwd: 'apps/cli', tsconfig: 'apps/cli/tsconfig.runtime.json' },
  { id: 'cli', entry: 'apps/cli/src/index.ts', cwd: 'apps/cli', tsconfig: 'apps/cli/tsconfig.runtime.json' },
  { id: 'voice-inference-worker', entry: 'apps/cli/src/daemon/voiceInference/forkedWorker/workerEntry.ts', cwd: 'apps/cli', tsconfig: 'apps/cli/tsconfig.runtime.json' },
  { id: 'server', entry: 'apps/server/sources/flavors/light/main.ts', cwd: 'apps/server', tsconfig: 'apps/server/tsconfig.json' },
  { id: 'ui-catalog', entry: 'apps/ui/sources/agents/catalog/catalog.test.ts', cwd: 'apps/ui' },
  { id: 'sdk-browser', entry: 'packages/sdk/scripts/validateBrowserConsumer.mjs', cwd: 'packages/sdk' },
]);

export async function loadEntryGraph(graph, { signal, repoDir = repo } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'hstack-entry-load-'));
  try {
    const ui = graph.id === 'ui-catalog';
    let nodeArgs = ui ? [] : ['--import', preload];
    let sourceEnv = {};
    if (graph.id === 'voice-inference-worker') {
      const { createCliSourceLoader } = await import(pathToFileURL(join(repoDir,
        'packages/cli-common/cliSourceLoader.mjs')).href);
      const loader = await createCliSourceLoader('hstack-voice-entry-invocation');
      try {
        const { buildHappyCliSubprocessInvocation } = await loader.import(pathToFileURL(join(repoDir,
          'apps/cli/src/utils/spawnHappyCLI.ts')).href, import.meta.url);
        const invocation = buildHappyCliSubprocessInvocation(['daemon', 'voice-inference-worker'], {
          environment: { ...process.env, HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
            HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '1', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: undefined,
            HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: undefined },
        });
        const sourceEntry = invocation.argv.indexOf(join(repoDir, 'apps/cli/src/index.ts'));
        if (invocation.runtime !== 'node' || sourceEntry < 0) throw new Error('Expected source worker invocation');
        // Consume the real source invocation's loader/conditions, substituting
        // only this import-only entry for its IPC-running CLI main.
        nodeArgs = invocation.argv.slice(0, sourceEntry);
        sourceEnv = invocation.env ?? {};
      } finally { await loader.unregister(); }
    }
    const entrypoint = ui
      ? createRequire(join(repo, 'apps/ui/package.json')).resolve('vitest/vitest.mjs') : self;
    const result = await probeRuntimeImport({ entrypoint,
      args: ui ? ['run', '--config', join(repoDir, 'apps/ui/vitest.config.ts'), 'sources/agents/catalog/catalog.test.ts']
        : [`--child=${graph.id}`, `--repo-dir=${repoDir}`],
      nodeArgs,
      cwd: join(repoDir, graph.cwd), signal,
      env: { ...process.env, ...sourceEnv, HAPPIER_HOME_DIR: home, HAPPIER_STACK_CLI_HOME_DIR: home,
        HAPPIER_SERVER_LIGHT_DATA_DIR: home, TSX_DISABLE_CACHE: '1',
        ...(graph.tsconfig ? { TSX_TSCONFIG_PATH: join(repoDir, graph.tsconfig) } : {}),
        HAPPIER_CLI_DIST_INTEGRITY_PROBE: '1', HAPPIER_CLI_RUNTIME_DISABLE: '1', HAPPIER_CLI_UPDATE_CHECK: '0' },
    });
    return { graph: graph.id, entry: graph.entry, basis: 'current-source', ...result,
      firstFailingModule: result.firstFailingModule === self ? graph.entry : result.firstFailingModule };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { graph: graph.id, entry: graph.entry, basis: 'current-source', status: 'failed',
      elapsedMs: 0, exitCode: null, signal: null, firstFailingModule: graph.entry,
      loadError: { name: error.name, code: error.code ?? null, message: 'Entry harness unavailable; check package dependency preparation' } };
  } finally { await rm(home, { recursive: true, force: true }); }
}

async function loadChild(id, repoDir = repo) {
  const graph = ENTRY_GRAPHS.find(graph => graph.id === id);
  if (!graph || id === 'ui-catalog') throw new Error('Unknown native entry graph');
  if (id === 'voice-inference-worker') {
    process.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX = '1';
    process.env.HAPPIER_VOICE_INFERENCE_WORKER_CHILD = '1';
    process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE = pathToFileURL(join(repoDir,
      'apps/cli/src/daemon/voiceInference/runtime/packagedVoiceInferenceRuntime.ts')).href;
    // Match CLI bootstrap → hidden worker entry → runtime override, without
    // starting IPC or loading native models during an import-only check.
    await import(pathToFileURL(join(repoDir, 'apps/cli/src/cli/bootstrap.ts')).href);
    await import(pathToFileURL(join(repoDir, graph.entry)).href);
    await import(process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE);
    return;
  }
  if (id === 'server') {
    await import(pathToFileURL(join(repoDir, 'apps/server/sources/configureZodLocale.ts')).href);
    await import(pathToFileURL(join(repoDir, 'apps/server/sources/flavors/full/main.ts')).href);
    const { runLightServerMain } = await import(pathToFileURL(join(repoDir, graph.entry)).href);
    await runLightServerMain(['--probe-runtime-import']);
  } else {
    const owner = await import(pathToFileURL(join(repoDir, graph.entry)).href);
    if (id === 'sdk-browser') await owner.validateBrowserConsumer({ loadOnly: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) {
  const child = process.argv[2]?.startsWith('--child=') ? process.argv[2].slice('--child='.length) : null;
  if (child) {
    const repoArg = process.argv.find(arg => arg.startsWith('--repo-dir='));
    await loadChild(child, repoArg ? resolve(repoArg.slice('--repo-dir='.length)) : repo);
  } else {
    if (process.argv.length > 2) throw new Error('Usage: entry-load.mjs (via hstack-exec AUTO)');
    let completedGraphs = 0;
    // Also reject an early process.exit(0); a trailing assertion cannot run then.
    process.once('exit', () => {
      if (completedGraphs !== ENTRY_GRAPHS.length) {
        writeSync(2, `Entry loads incomplete: ${completedGraphs}/${ENTRY_GRAPHS.length} graph results; missing: ${ENTRY_GRAPHS.slice(completedGraphs).map(graph => graph.id).join(', ')}\n`);
        process.exitCode = 1;
      }
    });
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Entry loads interrupted'));
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      // One process at a time bounds load without inventing a new worker pool.
      for (const graph of ENTRY_GRAPHS) {
        const result = await loadEntryGraph(graph, { signal: controller.signal });
        console.log(JSON.stringify(result));
        completedGraphs += 1;
        if (result.status === 'failed') process.exitCode = 1;
      }
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  }
}
