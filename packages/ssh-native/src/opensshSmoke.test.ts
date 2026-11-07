import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';

const execute = promisify(execFile);

for (const failure of [false, true]) {
  test(`OpenSSH smoke drains ${failure ? 'command failure diagnostics' : 'Docker port output'} after root exit`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ssh-smoke-output-'));
    try {
      const preload = join(root, 'process-boundary.mjs');
      // Docker, ssh-keygen and cargo are OS/process boundaries. Keep the real
      // smoke orchestration, port parser and TCP readiness path beneath them.
      await writeFile(preload, `
        import childProcess from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        import { EventEmitter } from 'node:events';
        import { PassThrough } from 'node:stream';
        import { writeFileSync } from 'node:fs';
        import { createServer } from 'node:net';
        const server = createServer(socket => socket.end());
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        childProcess.spawn = (command, args, options) => {
          const child = Object.assign(new EventEmitter(), {
            stdout: options.stdio === 'inherit' ? null : new PassThrough(),
            stderr: options.stdio === 'inherit' ? null : new PassThrough(),
          });
          const failed = ${failure} && command === 'ssh-keygen';
          if (command === 'ssh-keygen' && !failed) writeFileSync(args[args.indexOf('-f') + 1] + '.pub', 'fixture public key');
          if (command === 'docker' && args[0] === 'rm') server.close();
          setImmediate(() => {
            child.emit('exit', failed ? 1 : 0, null);
            setImmediate(() => {
              child.stdout?.end(failed ? 'final stdout' : command === 'docker' && args[0] === 'port'
                ? '127.0.0.1:' + port + '\\n' : '');
              child.stderr?.end(failed ? 'final stderr' : '');
              setImmediate(() => child.emit('close', failed ? 1 : 0, null));
            });
          });
          return child;
        };
        syncBuiltinESMExports();
      `);
      const invocation = execute(process.execPath, ['--import', preload,
        fileURLToPath(new URL('../scripts/openssh-smoke.mjs', import.meta.url))]);
      if (failure) {
        await assert.rejects(invocation, (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok('stderr' in error && typeof error.stderr === 'string');
          assert.match(error.stderr, /failed with 1\nfinal stdout\nfinal stderr/u);
          return true;
        });
      } else {
        await invocation;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
