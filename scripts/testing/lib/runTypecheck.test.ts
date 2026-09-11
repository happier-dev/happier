import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ROOT_TYPECHECK_COMMANDS, runRootTypecheck } from '../runTypecheck.ts';

const rootPackage = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts?: Record<string, string>;
};

test('root typecheck delegates to the phase runner without replacing the heartbeat owner', () => {
  assert.equal(
    rootPackage.scripts?.['typecheck:inner'],
    'node --experimental-strip-types scripts/testing/runTypecheck.ts',
  );
  assert.equal(
    rootPackage.scripts?.['typecheck:local'],
    'node scripts/runWithHeartbeat.mjs --label typecheck -- yarn -s typecheck:inner',
  );
});

test('root typecheck plan preserves prerequisite order and every Turbo workspace owner', () => {
  assert.deepEqual(ROOT_TYPECHECK_COMMANDS.map((command) => command.args), [
    ['-s', 'build:packages'],
    ['-s', 'prepare:typecheck:workspaces'],
    [
      'turbo',
      'run',
      'typecheck:finite',
      '--continue=always',
      '--filter=@happier-dev/plugin-sdk',
      '--filter=@happier-dev/sdk',
    ],
    [
      'turbo',
      'run',
      'typecheck:source:finite',
      '--continue=always',
      '--filter=@happier-dev/terminal-native',
      '--filter=@happier-dev/plugin-ui',
      '--filter=@happier-dev/app',
      '--filter=@happier-dev/cli',
      '--filter=@happier-dev/server',
      '--filter=@happier-dev/tests',
    ],
  ]);
});

test('root typecheck attempts every phase sequentially before reporting complete failures', async () => {
  const executed: string[] = [];
  let active = 0;
  let maximumActive = 0;

  await assert.rejects(
    runRootTypecheck({
      commands: [
        { id: 'build-packages', args: ['-s', 'build:packages'] },
        { id: 'public-sdk', args: ['turbo', 'run', 'typecheck:finite'] },
        { id: 'source-workspaces', args: ['turbo', 'run', 'typecheck:source:finite'] },
      ],
      runCommand: async (command) => {
        executed.push(command.id);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolveRun) => setImmediate(resolveRun));
        active -= 1;
        if (command.id !== 'source-workspaces') throw new Error(`${command.id} failed`);
      },
    }),
    (error: unknown) => {
      assert.match(String(error), /build-packages: build-packages failed/u);
      assert.match(String(error), /public-sdk: public-sdk failed/u);
      return true;
    },
  );

  assert.deepEqual(executed, ['build-packages', 'public-sdk', 'source-workspaces']);
  assert.equal(maximumActive, 1);
});
