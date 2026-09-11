import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseSharedPackageTestMode,
  SHARED_PACKAGE_TEST_COMMANDS,
  runSharedPackageTests,
} from './runSharedPackageTests.ts';

test('the shared-package suite includes previously unwired package and harness tests', () => {
  const commandText = SHARED_PACKAGE_TEST_COMMANDS.map(({ args }) => args.join(' ')).join('\n');

  for (const expected of [
    '@happier-dev/peer-transport test',
    '@happier-dev/release-runtime test',
    '@happier-dev/desktop test',
    '@happier-dev/desktop-native test',
    '@happier-dev/iroh-native test',
    '@happier-dev/website test',
    '@happier-dev/tests test:scripts:self',
  ]) {
    assert.match(commandText, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
});

test('the shared-package suite delegates every declared command to the aggregate owner', async () => {
  const executed: string[] = [];

  const commands = await runSharedPackageTests({
    commands: [
      { id: 'alpha', args: ['workspace', 'alpha', 'test'] },
      { id: 'beta', args: ['workspace', 'beta', 'test'] },
    ],
    runCommand: async (command) => {
      executed.push(command.id);
    },
  });

  assert.deepEqual(executed, ['alpha', 'beta']);
  assert.deepEqual(commands.map(({ id }) => id), ['alpha', 'beta']);
});

test('local selection omits only commands whose prerequisites are provisioned by CI', async () => {
  const localExecuted: string[] = [];
  const ciExecuted: string[] = [];

  const localCommands = await runSharedPackageTests({
    runCommand: async (command) => {
      localExecuted.push(command.id);
    },
  });
  const ciOptions = {
    mode: 'ci' as const,
    runCommand: async (command: { id: string; args: readonly string[] }) => {
      ciExecuted.push(command.id);
    },
  };
  const ciCommands = await runSharedPackageTests(ciOptions);

  assert.deepEqual(localExecuted, localCommands.map(({ id }) => id));
  assert.deepEqual(ciExecuted, SHARED_PACKAGE_TEST_COMMANDS.map(({ id }) => id));
  assert.deepEqual(ciCommands, SHARED_PACKAGE_TEST_COMMANDS);
  assert.ok(localExecuted.includes('privacy-kit:test'));
  assert.ok(!localExecuted.includes('privacy-kit:bun'));
  assert.ok(!localExecuted.includes('website'));
  assert.deepEqual(
    SHARED_PACKAGE_TEST_COMMANDS
      .map(({ id }) => id)
      .filter((id) => !localExecuted.includes(id)),
    ['privacy-kit:bun', 'website'],
  );
});

test('the CLI requires an explicit, valid mode when an argument is supplied', () => {
  assert.equal(parseSharedPackageTestMode([]), 'local');
  assert.equal(parseSharedPackageTestMode(['--mode', 'local']), 'local');
  assert.equal(parseSharedPackageTestMode(['--mode', 'ci']), 'ci');
  assert.throws(
    () => parseSharedPackageTestMode(['--mode', 'full']),
    /Usage: runSharedPackageTests\.ts \[--mode local\|ci\]/u,
  );
  assert.throws(
    () => parseSharedPackageTestMode(['--unknown']),
    /Usage: runSharedPackageTests\.ts \[--mode local\|ci\]/u,
  );
});
