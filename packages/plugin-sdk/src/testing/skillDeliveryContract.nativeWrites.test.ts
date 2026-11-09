import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { build } from 'esbuild';

it('rejects a native config-root write through the public skill contract kit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-skill-kit-native-write-'));
  try {
    const kitPath = fileURLToPath(new URL('./skillDeliveryContract.ts', import.meta.url));
    const observerPath = fileURLToPath(new URL('./observeAgentLaunch.ts', import.meta.url));
    const fixturePath = join(directory, 'fixture.test.mjs');
    const configPath = join(directory, 'vitest.config.mjs');
    await writeFile(configPath, 'export default { test: { include: ["fixture.test.mjs"], fileParallelism: false } };');
    // The fake Agent is the kit's self-test subject; every observation and assertion stays real.
    await writeFile(fixturePath, `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { runAgentSkillDeliveryContract } from ${JSON.stringify(kitPath)};
      import { createAgentLaunchObserver } from ${JSON.stringify(observerPath)};
      const home = ${JSON.stringify(join(directory, 'home'))};
      const nativeRoot = join(home, '.config', 'devin', 'skills');
      mkdirSync(nativeRoot, { recursive: true });
      const observer = createAgentLaunchObserver({ home });
      let mutation = 0;
      runAgentSkillDeliveryContract({ agent: {
        id: 'native-write-fixture', title: 'Native write fixture', primary: 'sessions', runtime: { kind: 'custom' },
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
          skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported', nativeRoots: { user: [['.config', 'devin', 'skills']] } } },
      }, async openSession() {
        observer.boundaries.reset();
        observer.boundaries.recordLaunch({ argv: ['--stdio'], env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config') } });
        writeFileSync(join(nativeRoot, 'SKILL.md'), 'Native mutation ' + (++mutation));
        return { send: async () => ({ status: 'admitted' }), cancel: async () => ({ status: 'notRunning' }),
          updateConfiguration: async () => ({ status: 'applied', changed: [] }), watch: () => ({ dispose() {} }), dispose: async () => {} };
      }, observeLaunch: observer.observeLaunch });
    `);
    // Compile the real kit once instead of asking the nested Vite worker to
    // transform the full SDK/Protocol source graph during this one assertion.
    // Vitest itself remains the genuine external runner boundary.
    const bundled = await build({
      entryPoints: [fixturePath], bundle: true, platform: 'node', format: 'esm', write: false,
      external: ['vitest', fileURLToPath(new URL('../../../../node_modules/vitest/dist/index.js', import.meta.url))],
      alias: { vitest: fileURLToPath(new URL('../../../../node_modules/vitest/dist/index.js', import.meta.url)) },
    });
    await writeFile(fixturePath, bundled.outputFiles[0]!.text);
    const result = await new Promise<Readonly<{ exitCode: number | string; stdout: string; stderr: string }>>(resolve => {
      execFile(process.execPath, [fileURLToPath(new URL('../../../../node_modules/vitest/vitest.mjs', import.meta.url)),
        'run', '--root', directory, '--config', configPath, '--reporter=json'], (error, stdout, stderr) => {
        resolve({ exitCode: error?.code ?? 0, stdout, stderr });
      });
    });
    const report: unknown = JSON.parse(result.stdout);
    expect(report !== null && typeof report === 'object' ? Reflect.get(report, 'numFailedTests') : null, result.stdout + result.stderr).toBeGreaterThan(0);
    expect(result.exitCode, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('K5:');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
