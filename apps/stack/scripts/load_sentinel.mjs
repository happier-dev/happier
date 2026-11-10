import { constants, setPriority } from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { watchLoadSentinel } from './perf/load-sentinel.mjs';
import { isPublicRuntimeImportDiagnostic } from './utils/proc/runtimeImportProbe.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('hstack tools load-sentinel --board=<handoff-board-path> (foreground; Ctrl-C stops)');
} else {
  let phase = 'configuration';
  try {
    const repoDir = resolve(process.env.HAPPIER_STACK_REPO_DIR ?? fileURLToPath(new URL('../../../', import.meta.url)));
    const boardArg = argv.find(arg => arg.startsWith('--board='));
    if (!boardArg || argv.length !== 1) throw new TypeError('Expected --board=<handoff-board-path>');
    const board = resolve(repoDir, boardArg.slice('--board='.length));
    phase = 'priority';
    setPriority(0, constants.priority.PRIORITY_LOW);
    if (process.platform === 'linux') {
      const priority = spawnSync('ionice', ['-c', '3', '-p', String(process.pid)], { stdio: 'ignore' });
      if (priority.error) throw priority.error;
      if (priority.status !== 0) throw Object.assign(new Error('Idle I/O priority unavailable'), { code: `ionice_exit_${priority.status}` });
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const temporary = await mkdtemp(join(tmpdir(), 'hstack-load-sentinel-'));
    try {
      phase = 'board-writer-load';
      const { postBoardEntry } = await import(pathToFileURL(resolve(repoDir, 'scripts/board/postBoardEntry.mjs')).href);
      console.log(`load-sentinel started pid=${process.pid}`);
      phase = 'watching';
      await watchLoadSentinel({ repoDir, signal: controller.signal,
        post: async entry => {
          const file = join(temporary, 'entry.md');
          try {
            await writeFile(file, entry, { mode: 0o600 });
            await postBoardEntry(board, file);
          } catch (error) { error.phase = 'board-write'; throw error; }
        },
        onResult: result => console.log(JSON.stringify({ graph: result.graph, status: result.status, elapsedMs: result.elapsedMs })),
      });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await rm(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    // Never print exception messages: even paths and loader diagnostics can carry secrets.
    const code = error.code ?? error.name;
    console.error(JSON.stringify({ event: 'load-sentinel-stopped', phase: error.phase ?? phase,
      code: isPublicRuntimeImportDiagnostic(code) && /^[\w-]+$/.test(code) ? code : 'redacted' }));
    process.exitCode = 1;
  }
}
