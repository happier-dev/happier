import { createRequire } from 'node:module';
import { realpathSync, writeSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withDependencyConsumption } from '../utils/proc/dependency_refresh.mjs';
import { describeRuntimeImportFailure, probeRuntimeImport } from '../utils/proc/runtimeImportProbe.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const self = fileURLToPath(import.meta.url);

import { BUNDLED_MANIFEST_GRAPH, ENTRY_GRAPHS } from './entry-graphs.mjs';
export { ENTRY_GRAPHS } from './entry-graphs.mjs';

export async function loadEntryGraph(graph, { signal, repoDir = repo, env = process.env, traceImports = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'hstack-entry-load-'));
  try {
    // Each graph is actual installed-module consumption, after host admission.
    // Release between graphs so a queued refresh can publish before the next.
    return await withDependencyConsumption({ installDir: repoDir, env, signal }, async readerEnv => {
      const ui = graph.id === 'ui-catalog';
      let nodeArgs = ui ? [] : ['--import', join(repoDir, 'packages/cli-common/registerSourceRuntime.mjs'),
        ...(graph.conditions ?? []).map(condition => `--conditions=${condition}`)];
      let sourceEnv = {};
      if (graph.id === 'voice-inference-worker') {
        const { createCliSourceLoader } = await import(pathToFileURL(join(repoDir,
          'packages/cli-common/cliSourceLoader.mjs')).href);
        const loader = await createCliSourceLoader('hstack-voice-entry-invocation');
        try {
          const { buildHappyCliSubprocessInvocation } = await loader.import(pathToFileURL(join(repoDir,
            'apps/cli/src/utils/spawnHappyCLI.ts')).href, import.meta.url);
          const invocation = buildHappyCliSubprocessInvocation(['daemon', 'voice-inference-worker'], {
            environment: { ...readerEnv, HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
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
      if (traceImports) nodeArgs.push('--import', fileURLToPath(new URL('./import-trace.mjs', import.meta.url)));
      const entrypoint = graph.args ? join(repoDir, graph.entry) : ui
        ? createRequire(join(repo, 'apps/ui/package.json')).resolve('vitest/vitest.mjs') : self;
      const result = await probeRuntimeImport({ entrypoint,
        args: graph.args ?? (ui ? ['run', '--config', join(repoDir, 'apps/ui/vitest.config.ts'),
          ...(traceImports ? ['--reporter', fileURLToPath(new URL('./ui-import-trace.mjs', import.meta.url))] : []),
          ...graph.testFiles]
          : [`--child=${graph.id}`, `--repo-dir=${repoDir}`]),
        nodeArgs,
        cwd: join(repoDir, graph.cwd), signal,
        env: { ...readerEnv, ...sourceEnv, HAPPIER_ENTRY_IMPORT_TRACE: traceImports ? join(home, 'imports.jsonl') : undefined,
          HAPPIER_ENTRY_IMPORT_FAILURE: traceImports ? join(home, 'failure.json') : undefined,
          HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_HOME_DIR: home, HAPPIER_STACK_CLI_HOME_DIR: home,
          HAPPIER_SERVER_LIGHT_DATA_DIR: home, TSX_DISABLE_CACHE: '1',
          ...(graph.tsconfig ? { TSX_TSCONFIG_PATH: join(repoDir, graph.tsconfig) } : {}),
          HAPPIER_CLI_DIST_INTEGRITY_PROBE: '1', HAPPIER_CLI_RUNTIME_DISABLE: '1', HAPPIER_CLI_UPDATE_CHECK: '0' },
      });
      let importEdges;
      if (traceImports) {
        const recorded = await readFile(join(home, 'imports.jsonl'), 'utf8').catch(error => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
        importEdges = recorded.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        if (ui && result.status === 'failed') {
          const failure = await readFile(join(home, 'failure.json'), 'utf8').catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (failure) {
            const error = JSON.parse(failure);
            Object.assign(result, describeRuntimeImportFailure(
              `${error.name ?? 'Error'}${error.code ? ` [${error.code}]` : ''}: ${error.message}\n${error.stack ?? ''}`,
              join(repoDir, graph.entry)));
          }
        }
      }
      // The cycle guard analyzes source instead of importing it. Consume its
      // authored cycle diagnostics here, alongside native loader diagnostics.
      const cycle = graph.diagnosticSourceRoot && result.status === 'failed'
        ? result.loadError?.message.split('New cycle 1:')[1]?.split(/New cycle \d+:/)[0] : null;
      const eagerRead = cycle?.match(/Eager read: (.+) -> (.+) \(([^)]+)\)/);
      const failureImportPath = cycle ? [...cycle.matchAll(/^  - (.+)$/gm)]
        .map(match => join(repoDir, graph.diagnosticSourceRoot, match[1])) : undefined;
      if (eagerRead) {
        result.firstFailingModule = join(repoDir, graph.diagnosticSourceRoot, eagerRead[1]);
        result.loadError = { ...result.loadError, code: 'runtime_import_cycle', symbol: eagerRead[3] };
      }
      if (graph.id === BUNDLED_MANIFEST_GRAPH.id && result.loadError) {
        // The generator's diagnostic (the drifted output, its byte offset and
        // the generator's bounded actual/expected window, or the source error)
        // is what the manifest owner acts on: a blanked message left a
        // fleet-wide 13/14 with no cause (Fork C 2026-11-18). The load
        // sentinel still publishes identifiers only.
        const output = result.loadError.message.match(/(?:generated output differs|missing generated output): (.+?)(?: at byte \d+|$)/)?.[1];
        if (output) result.firstFailingModule = output;
      }
      return { graph: graph.id, entry: graph.entry, basis: 'current-source', ...result,
        ...(traceImports ? { importEdges } : {}),
        ...(failureImportPath?.length ? { failureImportPath } : {}),
        firstFailingModule: result.firstFailingModule === self ? graph.entry : result.firstFailingModule };
    });
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
