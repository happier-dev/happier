import { describe, expect, it } from 'vitest';

import { createLocalHappierJsonExecutor } from './happierJsonExecutor.js';

describe('local Happier process output completion', () => {
  it('retains JSON and stderr from an inherited pipe after the root exits', async () => {
    const executor = createLocalHappierJsonExecutor({
      processEnv: { HAPPIER_BOOTSTRAP_CLI_PATH: process.execPath },
    });
    // A real descendant owns the inherited pipes until after the root has exited.
    const rootScript = `
      const { spawn } = require('node:child_process');
      const descendantScript = \`
        function finishAfterRootExit() {
          try { process.kill(\${process.pid}, 0); }
          catch {
            process.stdout.write('true}');
            process.stderr.write('final diagnostic');
            return;
          }
          setTimeout(finishAfterRootExit, 1);
        }
        finishAfterRootExit();
      \`;
      process.stdout.write('{"ok":', () => {
        spawn(process.execPath, ['-e', descendantScript], {
          stdio: ['ignore', process.stdout, process.stderr],
        }).unref();
      });
    `;

    await expect(executor.runHappierText(['-e', rootScript])).resolves.toMatchObject({
      stdout: '{"ok":true}', stderr: 'final diagnostic', status: 0,
    });
  });
});
