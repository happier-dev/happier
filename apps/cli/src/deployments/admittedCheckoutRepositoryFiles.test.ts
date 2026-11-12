import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import {
  createLocalScmRepositoryFixture,
  runScmExecutable,
} from '@/testkit/scm/scmBackendContractFixtures';
import { createAdmittedCheckoutRepositoryFiles } from './admittedCheckoutRepositoryFiles';
import { createDeploymentGitRegistry } from './targets/ownServer/exactCommitRelease.testkit';

// Real Git, real filesystem owners; only the reviewed root is the scope.
let root: string;
let sibling: string;
const registry = createDeploymentGitRegistry();
const content = Buffer.from('changed\n', 'utf8').toString('base64');
const succeeded = (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  'success' in value &&
  value.success === true;

beforeEach(async () => {
  root = createLocalScmRepositoryFixture({
    executable: 'git',
    repoMode: '.git',
    prefix: 'admitted-checkout-',
  }).rootPath;
  // A sibling whose path shares the root as a string prefix.
  sibling = `${root}2`;
  await mkdir(sibling);
  runScmExecutable(sibling, 'git', ['init', '--quiet']);
  await writeFile(join(sibling, 'secret.txt'), 'other checkout\n');
  await symlink(sibling, join(root, 'link'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(sibling, { recursive: true, force: true });
});

const own = (): ActionExecutorContext => ({});

it('runs SCM and file effects inside the reviewed checkout', async () => {
  const files = createAdmittedCheckoutRepositoryFiles({
    root,
    context: own(),
    registry,
  });
  expect(
    succeeded(
      await files.executeScm('scm.status.snapshot', {
        includeWorktreeStatus: false,
      }),
    ),
  ).toBe(true);
  expect(
    succeeded(
      await files.writeFile({
        rootPath: root,
        path: 'deploy/compose.yaml',
        content,
        expectedHash: null,
      }),
    ),
  ).toBe(true);
  expect(await readFile(join(root, 'deploy/compose.yaml'), 'utf8')).toBe(
    'changed\n',
  );
});

it.each([
  ['a dot-dot escape', () => join(root, '..', `${root.split('/').pop()}2`)],
  ['a sibling with the same prefix', () => sibling],
  ['a symlink to another checkout', () => join(root, 'link')],
])('refuses SCM through %s', async (_case, cwd) => {
  const files = createAdmittedCheckoutRepositoryFiles({
    root,
    context: own(),
    registry,
  });
  const result = await files.executeScm('scm.status.snapshot', {
    cwd: cwd(),
    includeWorktreeStatus: false,
  });
  expect(succeeded(result), JSON.stringify(result)).toBe(false);
});

it.each([
  [
    'a dot-dot path',
    () => ({
      rootPath: root,
      path: `../${sibling.split('/').pop()}/secret.txt`,
    }),
  ],
  [
    'a symlinked directory',
    () => ({ rootPath: root, path: 'link/secret.txt' }),
  ],
  ['another root', () => ({ rootPath: sibling, path: 'secret.txt' })],
])('refuses file writes and deletes through %s', async (_case, target) => {
  const files = createAdmittedCheckoutRepositoryFiles({
    root,
    context: own(),
    registry,
  });
  expect(
    succeeded(
      await files.writeFile({ ...target(), content, expectedHash: null }),
    ),
  ).toBe(false);
  expect(
    succeeded(await files.deleteFile({ ...target(), recursive: false })),
  ).toBe(false);
  expect(await readFile(join(sibling, 'secret.txt'), 'utf8')).toBe(
    'other checkout\n',
  );
});

it('refuses another Account before any effect', () => {
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
    v: 1,
    token: 'member-root',
    binding: {
      accountId: 'member',
      authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'home',
      machineId: 'machine',
      installationId: 'installation',
      custodianAccountId: 'owner',
      accountEncryptionMode: 'plain',
      actionId: 'deployments.environments.moveToRepository',
      requestId: 'request',
      requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' },
      environmentId: 'environment',
    },
  });
  expect(() =>
    createAdmittedCheckoutRepositoryFiles({
      root,
      registry,
      context: { externalActionExecutionAuthorization: authorization },
    }),
  ).toThrow('checkout_owner_required');
  expect(existsSync(join(root, '.git'))).toBe(true);
});
