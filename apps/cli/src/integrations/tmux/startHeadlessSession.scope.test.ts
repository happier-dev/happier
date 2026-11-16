import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { withTempDir } from '@/testkit/fs/tempDir';
import { startHappyHeadlessInTmux } from './startHeadlessSession';

describe('headless tmux Session scope', () => {
  it.skipIf(process.platform === 'win32')('starts concurrent continuations with their Session environment, directory and tmux selection', async () => {
    await withTempDir('tmux-session-scope-', async root => {
      const bin = join(root, 'bin');
      await mkdir(bin);
      const path = `${bin}${delimiter}${process.env.PATH ?? ''}`;
      // The external tmux server owns its window environment independently of its clients.
      await writeExecutableShim({ dir: bin, fileName: 'tmux', contents: `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('list-sessions')) process.stdout.write('scoped\\t1\\t123\\n');
if (args.includes('new-window')) {
  const cwdIndex = args.indexOf('-c');
  const command = args[args.indexOf(';') - 1];
  const child = spawnSync('/bin/sh', ['-c', command], {
    cwd: cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd(),
    env: { PATH: ${JSON.stringify(path)} }, encoding: 'utf8',
  });
  if (child.status !== 0) { process.stderr.write(child.stderr || 'window failed'); process.exit(child.status ?? 1); }
  process.stdout.write('@7\\t@7\\t123\\n');
}
` });

      await Promise.all(['alpha', 'beta'].map(async name => {
        const directory = join(root, name);
        await mkdir(directory);
        const resultPath = join(directory, 'result.json');
        const entrypoint = join(directory, 'continuation.mjs');
        await writeFile(entrypoint, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
  sessionValue: process.env.SESSION_VALUE ?? null,
  cwd: process.cwd(), args: process.argv.slice(2),
}));
`);
        await runAddedHostedSession({
          environment: {
            NODE_ENV: 'test',
            PATH: path, SESSION_VALUE: name, TMUX: '/tmp/session-tmux,123,0',
            HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
            HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
            HAPPIER_CLI_SUBPROCESS_PREFER_TSX: 'false',
            HAPPIER_JS_RUNTIME_PATH: process.execPath,
          },
          workingDirectory: directory, end: () => {},
        }, async () => {
          await Promise.resolve();
          await startHappyHeadlessInTmux([], { output: 'silent' });
        });

        const observation: unknown = JSON.parse(await readFile(resultPath, 'utf8'));
        expect(observation).toMatchObject({
          sessionValue: name, cwd: directory,
          args: expect.arrayContaining([expect.stringMatching(/^scoped:happy-/)]),
        });
      }));
    });
  });
});
