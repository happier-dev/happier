import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

for (const credential of ['token', 'interactive']) {
  test(`startup ${credential} evidence drains output after root exit`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-startup-output-'));
    try {
      const preload = join(root, 'process-boundary.mjs');
      // Replace only the spawned CLI/credential-writer process. The measurement,
      // filesystem evidence, JSON parsing and loopback Home remain real.
      await writeFile(preload, `
        import childProcess from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        import { EventEmitter } from 'node:events';
        import { PassThrough } from 'node:stream';
        import { performance } from 'node:perf_hooks';
        let clock = 100;
        Object.defineProperty(performance, 'now', { value: () => clock });
        childProcess.spawn = (_command, args) => {
          const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
          const seed = args.includes('--eval');
          setImmediate(() => {
            clock = 250;
            child.emit('exit', seed ? 1 : 0, null);
            setImmediate(() => {
              clock = 900;
              child.stdout.end(seed ? '' : '{"ok":true}');
              child.stderr.end(seed ? 'final fixture admission diagnostic' : '');
              setImmediate(() => child.emit('close', seed ? 1 : 0, null));
            });
          });
          return child;
        };
        syncBuiltinESMExports();
      `);
      const invocation = execute(process.execPath, ['--import', preload,
        fileURLToPath(new URL('./cli-startup.mjs', import.meta.url)), 'contract'], {
        env: { ...process.env, CLISTART_OUTPUT_ROOT: root, CLISTART_REPEATS: '1', CLISTART_PLAIN: '1',
          CLISTART_CREDENTIAL: credential, CLISTART_COMMAND: 'security' },
      });
      if (credential === 'interactive') {
        await assert.rejects(invocation, (error) => {
          assert.match(error.stderr, /Interactive fixture admission failed \(1\): final fixture admission diagnostic/u);
          return true;
        });
      } else {
        const { stdout } = await invocation;
        const row = JSON.parse(stdout.trim().split('\n')[0]);
        assert.equal(row.valid, true);
        assert.equal(await readFile(row.stdoutPath, 'utf8'), '{"ok":true}');
        assert.equal(row.code, 0);
        assert.equal(row.elapsedMs, 150, 'elapsed time measures root exit, excluding pipe drainage');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
