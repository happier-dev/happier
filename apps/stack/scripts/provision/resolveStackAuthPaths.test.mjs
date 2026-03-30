import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveQaStackName,
  resolveServerPortFromUiUrl,
  resolveStackCliAccessKeyCandidates,
  resolveStackNameFromServerPort,
} from '../../../../.project/scripts/qa/resolveStackAuthPaths.mjs';

test('resolveServerPortFromUiUrl extracts server port from server= query param', () => {
  const uiUrl = 'http://localhost:19364/?server=http%3A%2F%2Flocalhost%3A53288&happier_hmr=0';
  assert.equal(resolveServerPortFromUiUrl(uiUrl), 53288);
});

test('resolveQaStackName prefers explicit stack name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-resolve-stack-auth-explicit-'));
  const homeDir = join(root, 'home');
  await mkdir(homeDir, { recursive: true });

  const uiUrl = 'http://localhost:19364/?server=http%3A%2F%2Flocalhost%3A53288';
  const stackName = resolveQaStackName({ uiUrl, explicitStackName: 'explicit-stack', homeDir });
  assert.equal(stackName, 'explicit-stack');
});

test('resolveQaStackName selects newest stack runtime matching server port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-resolve-stack-auth-'));
  const homeDir = join(root, 'home');
  const stacksRoot = join(homeDir, '.happier', 'stacks');

  const stackOld = join(stacksRoot, 'stack-old');
  const stackNew = join(stacksRoot, 'stack-new');
  await mkdir(stackOld, { recursive: true });
  await mkdir(stackNew, { recursive: true });

  await writeFile(
    join(stackOld, 'stack.runtime.json'),
    JSON.stringify({ ports: { server: 53288 }, updatedAt: '2026-03-23T10:00:00.000Z' }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(
    join(stackNew, 'stack.runtime.json'),
    JSON.stringify({ runtime: { ports: { server: 53288 } }, updatedAt: '2026-03-23T12:00:00.000Z' }, null, 2) + '\n',
    'utf8',
  );

  const uiUrl = 'http://localhost:19364/?server=http%3A%2F%2Flocalhost%3A53288&happier_hmr=0';
  assert.equal(resolveQaStackName({ uiUrl, explicitStackName: '', homeDir }), 'stack-new');
  assert.equal(resolveStackNameFromServerPort({ serverPort: 53288, homeDir }), 'stack-new');
});

test('resolveStackCliAccessKeyCandidates returns deterministic access.key candidates under cli root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-resolve-stack-auth-access-key-'));
  const homeDir = join(root, 'home');
  const stackName = 'stack-test';

  const cliRoot = join(homeDir, '.happier', 'stacks', stackName, 'cli');
  await mkdir(join(cliRoot, 'servers', 'server_a'), { recursive: true });
  await mkdir(join(cliRoot, 'servers', 'server_b'), { recursive: true });

  const candidates = resolveStackCliAccessKeyCandidates({ stackName, homeDir });
  assert.equal(candidates[0], join(cliRoot, 'access.key'));
  assert.ok(candidates.includes(join(cliRoot, 'servers', 'server_a', 'access.key')));
  assert.ok(candidates.includes(join(cliRoot, 'servers', 'server_b', 'access.key')));
});
