import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { resolveQaUiUrl } from './resolveQaUiUrl.mjs';

test('resolveQaUiUrl borrows producer Expo while routing the named consumer origin to its own server', async () => {
  const stacksDir = await mkdtemp(join(tmpdir(), 'qa-ui-borrowed-expo-'));
  const consumerStackName = 'qa-agent-17';
  const producerStackName = 'repo-happier-producer';
  try {
    await mkdir(join(stacksDir, consumerStackName), { recursive: true });
    await mkdir(join(stacksDir, producerStackName), { recursive: true });
    await writeFile(
      join(stacksDir, consumerStackName, 'env'),
      `HAPPIER_STACK_EXPO_SOURCE_STACK=${producerStackName}\n`,
      'utf8',
    );
    await writeFile(
      join(stacksDir, consumerStackName, 'stack.runtime.json'),
      JSON.stringify({ stackName: consumerStackName, ports: { server: 53288 }, runtimeSnapshotId: 'snap-1' }),
      'utf8',
    );
    await writeFile(
      join(stacksDir, producerStackName, 'stack.runtime.json'),
      JSON.stringify({ stackName: producerStackName, expo: { webPort: 19364 } }),
      'utf8',
    );

    const url = new URL(resolveQaUiUrl({
      HAPPIER_QA_STACKS_DIR: stacksDir,
      HAPPIER_QA_STACK_NAME: consumerStackName,
    }));

    assert.equal(url.hostname, 'happier-qa-agent-17.localhost');
    assert.equal(url.port, '19364');
    assert.equal(url.searchParams.get('server'), 'http://happier-qa-agent-17.localhost:53288');
    assert.equal(url.searchParams.get('happier_hmr'), '0');
  } finally {
    await rm(stacksDir, { recursive: true, force: true });
  }
});

test('resolveQaUiUrl uses the selected snapshot static UI when requested', async () => {
  const stacksDir = await mkdtemp(join(tmpdir(), 'qa-ui-snapshot-'));
  const stackName = 'qa-static';
  try {
    await mkdir(join(stacksDir, stackName), { recursive: true });
    await writeFile(
      join(stacksDir, stackName, 'stack.runtime.json'),
      JSON.stringify({ stackName, ports: { server: 54000 }, runtimeSnapshotId: 'snap-1' }),
      'utf8',
    );

    const url = new URL(resolveQaUiUrl({
      HAPPIER_QA_STACKS_DIR: stacksDir,
      HAPPIER_QA_STACK_NAME: stackName,
      HAPPIER_QA_UI_MODE: 'snapshot',
    }));

    assert.equal(url.toString(), 'http://happier-qa-static.localhost:54000/');
  } finally {
    await rm(stacksDir, { recursive: true, force: true });
  }
});

test('resolveQaUiUrl rejects a borrowed Expo producer that escapes managed stack storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qa-ui-borrowed-expo-trust-'));
  const stacksDir = join(root, 'stacks');
  const consumerStackName = 'qa-agent-17';
  try {
    await mkdir(join(stacksDir, consumerStackName), { recursive: true });
    await writeFile(
      join(stacksDir, consumerStackName, 'env'),
      'HAPPIER_STACK_EXPO_SOURCE_STACK=../outside\n',
      'utf8',
    );
    await writeFile(
      join(stacksDir, consumerStackName, 'stack.runtime.json'),
      JSON.stringify({ stackName: consumerStackName, ports: { server: 53288 } }),
      'utf8',
    );
    await mkdir(join(root, 'outside'), { recursive: true });
    await writeFile(
      join(root, 'outside', 'stack.runtime.json'),
      JSON.stringify({ stackName: 'outside', expo: { webPort: 19364 } }),
      'utf8',
    );

    assert.throws(
      () => resolveQaUiUrl({
        HAPPIER_QA_STACKS_DIR: stacksDir,
        HAPPIER_QA_STACK_NAME: consumerStackName,
      }),
      /invalid borrowed Expo producer stack name/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
