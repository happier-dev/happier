import assert from 'node:assert/strict';
import test from 'node:test';

import { runCommandSuite } from './runCommandSuite.ts';

test('attempts every command before reporting the complete failure set', async () => {
  const executed: string[] = [];

  await assert.rejects(
    runCommandSuite({
      commands: [
        { id: 'alpha', args: ['workspace', 'alpha', 'test'] },
        { id: 'beta', args: ['workspace', 'beta', 'test'] },
        { id: 'gamma', args: ['workspace', 'gamma', 'test'] },
      ],
      runCommand: async (command) => {
        executed.push(command.id);
        if (command.id !== 'beta') throw new Error(`${command.id} failed`);
      },
    }),
    (error: unknown) => {
      assert.match(String(error), /alpha: alpha failed/u);
      assert.match(String(error), /gamma: gamma failed/u);
      return true;
    },
  );

  assert.deepEqual(executed, ['alpha', 'beta', 'gamma']);
});

test('bounds independent command execution without skipping later commands', async () => {
  let active = 0;
  let maximumActive = 0;
  const releases: Array<() => void> = [];

  const run = runCommandSuite({
    commands: ['alpha', 'beta', 'gamma'].map((id) => ({ id, args: [id] })),
    maxConcurrent: 2,
    runCommand: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    },
  });

  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  releases.shift()?.();
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((release) => release());
  await run;

  assert.equal(maximumActive, 2);
});
