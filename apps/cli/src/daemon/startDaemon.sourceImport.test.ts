import { once } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';

import { describe, expect, it, onTestFailed, onTestFinished } from 'vitest';

import { projectPath } from '@/projectPath';
import { withTempDir } from '@/testkit/fs/tempDir';
import { spawnTestProcess } from '@/testkit/process/spawn';
import { resolveCliTsxTsconfigPath } from '@/utils/spawnHappyCLI';

describe('daemon source imports', () => {
  it.each(['daemon/startup/createDaemonMachineBootstrapRuntime.ts', 'daemon/startDaemon.ts', 'cli/commands/daemonControl.ts'])('loads %s through the TSX source loader without starting a daemon', async (entry) => {
    const cliRoot = projectPath();
    const tsconfigPath = resolveCliTsxTsconfigPath();
    const sourceRuntimeUrl = pathToFileURL(join(cliRoot, '..', '..', 'packages', 'cli-common', 'registerSourceRuntime.mjs')).href;
    const daemonBootstrapUrl = pathToFileURL(join(
      cliRoot,
      'src',
      entry,
    )).href;

    await withTempDir('happier-daemon-source-import-', async (tempDir) => {
      const probePath = join(tempDir, 'daemon-source-import.ts');
      await writeFile(
        probePath,
        [
          'import { registerHooks } from "node:module";',
          'registerHooks({ load(url, context, nextLoad) { if (/\\/ui\\/doctor(?:Snapshot)?\\.ts$/.test(url.split("?")[0])) throw new Error("Doctor diagnostics eagerly loaded before demand"); return nextLoad(url, context); } });',
          'const report = (phase) => process.stdout.write(JSON.stringify({ phase, uptimeMs: Math.round(process.uptime() * 1000), tsxCacheDisabled: process.env.TSX_DISABLE_CACHE === "1", resources: process.getActiveResourcesInfo() }) + "\\n");',
          'process.once("beforeExit", () => report("before-exit"));',
          '(async () => {',
          '  report("import-started");',
          `  await import(${JSON.stringify(daemonBootstrapUrl)});`,
          '  report("import-completed");',
          '})().catch((error) => {',
          '  console.error(error);',
          '  process.exitCode = 1;',
          '});',
        ].join('\n'),
        'utf8',
      );

      // Source checks must read the current workspace closure, not combine
      // source CLI imports with stale emitted dependency exports. The canonical
      // source preload owns TSX and its cache policy; this test owns only its probe.
      const child = spawnTestProcess(process.execPath, ['--import', sourceRuntimeUrl, probePath], {
        cwd: cliRoot,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: tsconfigPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const spawnedAtMs = performance.now();
      const closed = once(child, 'close');
      const diagnostics: string[] = [];
      child.stdout?.on('data', chunk => diagnostics.push(String(chunk)));
      child.stderr?.on('data', chunk => diagnostics.push(String(chunk)));
      onTestFailed(() => {
        console.error('Daemon source import probe:', {
          parentElapsedSinceSpawnMs: Math.round(performance.now() - spawnedAtMs),
        });
        console.error(diagnostics.join(''));
      });
      onTestFinished(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await closed;
        }
      });
      const [code] = await closed;
      expect(code, diagnostics.join('')).toBe(0);
      expect(diagnostics.join('')).toContain('"phase":"import-completed"');
      expect(diagnostics.join('')).toContain('"phase":"before-exit"');
    });
  }, 180_000);
});
