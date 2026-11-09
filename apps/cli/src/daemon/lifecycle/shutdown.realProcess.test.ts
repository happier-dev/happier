import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, onTestFinished } from 'vitest';

import { projectPath } from '@/projectPath';
import { withTempDir } from '@/testkit/fs/tempDir';
import { spawnTestProcess } from '@/testkit/process/spawn';
import { resolveCliTsxTsconfigPath } from '@/utils/spawnHappyCLI';

type Scenario = 'handled' | 'rejection' | 'strict_rejection' | 'exception' | 'exit' | 'signal';

async function probe(scenario: Scenario, level = 'info') {
  return await withTempDir('happier-daemon-materialization-exit-', async tempDir => {
    const cliRoot = projectPath();
    const sourceUrl = (path: string) => pathToFileURL(join(cliRoot, 'src', path)).href;
    const entry = join(tempDir, 'probe.ts');
    await writeFile(entry, [
      '(async () => {',
      'const { writeFile } = await import("node:fs/promises");',
      'const { join } = await import("node:path");',
      `const { createDaemonShutdownController } = await import(${JSON.stringify(sourceUrl('daemon/lifecycle/shutdown.ts'))});`,
      `const { ensurePrivateConnectedServiceMaterializedRoot } = await import(${JSON.stringify(sourceUrl('daemon/connectedServices/materialize/privateMaterializedRoot.ts'))});`,
      `const { observeConnectedServiceMaterializationPhase } = await import(${JSON.stringify(sourceUrl('daemon/connectedServices/materialize/materializationPhase.ts'))});`,
      'const controller = createDaemonShutdownController();',
      'void controller.resolvesWhenShutdownRequested.then(request => process.exit(request.source === "exception" ? 1 : 0));',
      `const root = ${JSON.stringify(tempDir)};`,
      'const blocked = join(root, "blocked");',
      'await writeFile(blocked, "ordinary-file");',
      'const prepare = () => observeConnectedServiceMaterializationPhase({ agentId: "codex", materializationKey: "process-probe" }, "materialization_root_prepare", () => ensurePrivateConnectedServiceMaterializedRoot(join(blocked, "child")));',
      scenario === 'handled'
        ? 'try { await prepare(); process.exit(3); } catch { await ensurePrivateConnectedServiceMaterializedRoot(join(root, "valid")); process.stdout.write("host_survived\\n"); process.exit(0); }'
        : scenario === 'exception'
          ? 'try { await prepare(); process.exit(3); } catch (error) { setImmediate(() => { throw error; }); }'
          : scenario === 'exit'
            ? 'process.exit(7);'
            : scenario === 'signal'
              ? 'setInterval(() => {}, 1000); process.kill(process.pid, "SIGTERM");'
              : 'void prepare();',
      '})().catch(() => { process.exit(2); });',
    ].join('\n'));
    const preload = pathToFileURL(join(cliRoot, '..', '..', 'packages', 'cli-common', 'registerSourceRuntime.mjs')).href;
    const child = spawnTestProcess(process.execPath, [
      ...(scenario === 'strict_rejection' ? ['--unhandled-rejections=strict'] : []),
      '--import', preload, entry, 'daemon', 'start-sync',
    ], {
      cwd: cliRoot,
      env: { ...process.env, HAPPIER_HOME_DIR: tempDir, HAPPIER_LOG_LEVEL: level,
        TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(), DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
    });
    const [code, signal] = await closed;
    const logs = await readdir(join(tempDir, 'logs')).catch(() => []);
    const log = (await Promise.all(logs.filter(name => name.endsWith('.log'))
      .map(name => readFile(join(tempDir, 'logs', name), 'utf8')))).join('\n');
    // Never surface the probe's unfiltered log or stderr on assertion failure.
    expect(stderr.length, 'probe must keep terminal output empty').toBe(0);
    return { code, signal, stdout, log };
  });
}

describe('daemon process termination during materialization', () => {
  it('keeps the host alive after a handled root-prepare filesystem refusal', async () => {
    const result = await probe('handled');
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe('host_survived\n');
    expect(result.log.includes('[FATAL]')).toBe(false);
    expect(result.log.includes('daemon_process_exit')).toBe(true);
  });

  it.each([
    ['rejection', 'daemon_unhandled_rejection', 'info'],
    ['strict_rejection', 'daemon_uncaught_exception', 'info'],
    ['exception', 'daemon_uncaught_exception', 'info'],
    ['exception', 'daemon_uncaught_exception', 'debug'],
    ['rejection', 'daemon_unhandled_rejection', 'silent'],
  ] as const)('records %s as %s with logging %s', async (scenario, reason, level) => {
    const result = await probe(scenario, level);
    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.log.includes(reason), 'fatal reason must reach the real file before exit').toBe(true);
    expect(result.log.includes('blocked'), 'fatal diagnostics must omit materialization paths').toBe(false);
  });

  it('records an explicit nonzero exit even with ordinary file logging disabled', async () => {
    const result = await probe('exit', 'silent');
    expect(result.code).toBe(7);
    expect(result.log.includes('daemon_process_exit_nonzero')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('records an OS shutdown reason before graceful signal exit', async () => {
    const result = await probe('signal');
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.log.includes('daemon_shutdown_requested')).toBe(true);
    expect(result.log.includes('os-signal')).toBe(true);
  });
});
