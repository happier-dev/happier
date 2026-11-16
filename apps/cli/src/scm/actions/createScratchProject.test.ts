import axios from 'axios';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { ProjectSourcesCreateOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createGithubForgeHttpFixture } from '@/testkit/scm/githubForgeHttp';
import { createBitbucketForgeHttpFixture } from '@/testkit/scm/bitbucketForgeHttp';
import { createAzureDevopsForgeCliFixture } from '@/testkit/scm/azureDevopsForgeCli';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { executeConfiguredFilesystemEffect } from '@/rpc/handlers/fileSystem/filesystemEffectOperation';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { openProject } from '@/workspaces/activation/openProject';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { executeScmActionOperation } from './executeScmActionOperation';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.each([{ destination: 'absent', providerKind: 'github' }, { destination: 'absent', providerKind: 'bitbucket' },
  { destination: 'absent', providerKind: 'azure-devops' },
  { destination: 'occupied', providerKind: 'github' }, { destination: 'file', providerKind: 'github' }] as const)(
  'creates scratch through the real filesystem, SCM, $providerKind Forge and Project owners at an $destination destination', async ({ destination, providerKind }) => {
  const root = await mkdtemp(join(tmpdir(), 'scratch-project-'));
  roots.push(root);
  await seedTestServerProfile({ id: 'srv_test_home', homeId: 'srv_test_home', serverUrl: 'https://home.example' });
  const directory = join(root, 'bakery');
  if (destination === 'occupied') {
    await mkdir(directory);
    await writeFile(join(directory, 'personal.txt'), 'keep');
  }
  if (destination === 'file') await writeFile(directory, 'keep');
  const cloneUrl = providerKind === 'azure-devops' ? 'https://dev.azure.com/team-b/apps/_git/bakery'
    : `https://${providerKind === 'github' ? 'github.com' : 'bitbucket.org'}/alice/bakery.git`;
  const forge = providerKind === 'github'
    ? createGithubForgeHttpFixture({ nameWithOwner: 'alice/bakery', cloneUrl, repositoryExists: false })
    : providerKind === 'bitbucket' ? createBitbucketForgeHttpFixture({ nameWithOwner: 'alice/bakery', cloneUrl })
    : createAzureDevopsForgeCliFixture({ cloneUrl });
  const registration = createGitScmBackendRuntimeRegistration();
  if (!registration.runtime) throw new Error('Git runtime missing');
  const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
    definition: { id: registration.id, kind: 'git' }, qualifiedId: `happier.scm.backend.git/${registration.id}`,
    executableDefinition: registration.runtime, registration,
    hostingProviderRuntimeServices: 'runtimeServices' in forge ? forge.runtimeServices
      : { resolveScmHostingProviderRegistry: async () => forge.hosting },
  })]);
  const rows: unknown[] = [];
  const accountRows = createProjectAccountRowsHttpBoundary(rows);
  let source: ReturnType<typeof ProjectSourcesCreateOutputV1Schema.parse> | undefined;
  // Home HTTP and Forge HTTP/token acquisition are the external boundaries.
  // Source selection admission, Project acceptance, native filesystem and Git run real.
  vi.spyOn(axios, 'post').mockImplementation(accountRows);
  vi.spyOn(axios, 'request').mockImplementation(async () => ({ status: 200, data: source }));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (!String(url).includes('/v1/machines/')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    return { status: 200, data: { machine: { id: 'machine', active: true, installationId: 'installation',
      metadataVersion: 1, daemonStateVersion: 0, daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      metadata: encodePlainMachineStoredContent({ host: 'machine', platform: process.platform, homeDir: root,
        happyCliVersion: 'test', happyHomeDir: root }) } } };
  });
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`;
  const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: 'machine',
      installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
  const executor = createActionExecutor({
    filesystemActionExecute: ({ actionId, input }) => executeConfiguredFilesystemEffect({ workingDirectory: root,
      accessPolicy: { kind: 'restrictedRoots', roots: [root] } }, { actionId, input }),
    scmActionExecute: ({ actionId, input }) => executeScmActionOperation({ actionId, input, registry, workingDirectory: root }),
    projectSourcesCreate: async input => {
      source = ProjectSourcesCreateOutputV1Schema.parse({ ok: true, canManage: true,
        source: { name: input.name, repository: input.repository, defaultRef: input.defaultRef, audience: input.audience,
          id: 'source', revision: 1, createdByAccountId: 'alice' } });
      return source;
    },
    projectsOpen: input => openProject(input, { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example',
      machineId: 'machine', accountId: 'alice', registry, readCredentials: async () => ({ token, encryption: null }) }, context),
  });
  const description = '\nBuild a bakery website.\nKeep this message.\n';
  const result = await executor.execute('projects.starters.create', { serverId: 'srv_test_home', machineId: 'machine',
    requestKey: 'scratch-bakery', source: { kind: 'scratch' }, description, destinationParentPath: root,
    destinationDirectoryName: 'bakery', repository: { providerKind, owner: providerKind === 'azure-devops' ? 'team-b/apps' : 'alice', name: 'bakery',
      ...('providerId' in forge ? { providerId: forge.providerId, providerBaseUrl: forge.providerBaseUrl } : {}) } },
  { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
  if (destination !== 'absent') {
    expect(result).toMatchObject({ ok: true, result: { kind: 'failed', phase: 'checkout',
      code: destination === 'file' ? 'ENOTDIR' : SCM_OPERATION_ERROR_CODES.INVALID_PATH } });
    expect(await readFile(destination === 'file' ? directory : join(directory, 'personal.txt'), 'utf8')).toBe('keep');
    if (destination === 'occupied') expect(await readdir(directory)).toEqual(['personal.txt']);
    expect(forge.repositoryCreated()).toBe(false);
    expect(rows).toEqual([]);
    return;
  }
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'created', sourceId: 'source',
    sessionHandoff: { machineId: 'machine', directory, initialMessage: description } } });
  expect(result).not.toHaveProperty('result.commit');
  expect(runScmExecutable(directory, 'git', ['branch', '--show-current'])).toBe('main');
  expect(runScmExecutable(directory, 'git', ['remote', 'get-url', 'origin'])).toBe(cloneUrl);
  expect(await readdir(directory)).toEqual(['.git']);
  if ('httpRequests' in forge) expect(forge.httpRequests.filter(request => request.method === 'POST')).toEqual([{ method: 'POST',
    path: providerKind === 'github' ? '/user/repos' : '/2.0/repositories/alice/bakery' }]);
  else expect(forge.nativeRequests.filter(args => args[0] === 'repos' && args[1] === 'create')).toEqual([
    ['repos', 'create', '--organization', forge.providerBaseUrl, '--project', 'apps', '--name', 'bakery', '--output', 'json'],
  ]);
  expect(rows.length).toBeGreaterThan(0);
});
