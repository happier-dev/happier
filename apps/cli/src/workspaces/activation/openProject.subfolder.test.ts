import axios from 'axios';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  encodePlainMachineStoredContent,
  MACHINE_PLAIN_DATA_KEY_MARKER,
} from '@happier-dev/protocol/machines/machineStoredContent';
import {
  OpenProjectResultV1Schema,
  type OpenProjectInputV1,
} from '@happier-dev/protocol/projects/openProjectV1';

import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import {
  createBareRemoteRepository,
  makeCloneTargetDescription,
  makeProviderRegistry,
  makeRequest,
  runGit,
} from '../../../../../packages/plugins/scm-git/src/operations/repositoryCloneOperations.test-support';
import {
  createScmHostingProviderRuntimeServicesForTest,
  runWithRealGitScmRuntime,
} from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createScmBackendRegistry } from '@/scm/registry';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';

await import('@/scm/workspace/workspaceCheckoutOperations');
const { openProject } = await import('./openProject');

const temporaryRoots: string[] = [];

async function plainAccountRead(url: string) {
  if (!url.includes('/v1/machines/'))
    return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
  const id = url.slice(url.lastIndexOf('/') + 1);
  return {
    status: 200,
    data: {
      machine: {
        id,
        active: true,
        installationId: 'installation',
        metadataVersion: 1,
        daemonStateVersion: 0,
        daemonState: null,
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: encodePlainMachineStoredContent({
          host: id,
          platform: 'linux',
          homeDir: '/home/user',
          happyCliVersion: 'test',
          happyHomeDir: '/home/user/.happier',
        }),
      },
    },
  };
}

describe('openProject with a subfolder the repository lacks', () => {
  beforeEach(async () => {
    await seedTestServerProfile({
      id: 'srv_test_home',
      homeId: 'srv_test_home',
      serverUrl: 'https://home.example',
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it('refuses by name after the clone, keeps the clone and writes no Project (TL-A 20:35Z on 3ca2)', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-open-subfolder-'));
    temporaryRoots.push(parent);
    const remote = createBareRemoteRepository();
    temporaryRoots.push(join(remote, '..'));
    const registration = createGitScmBackendRuntimeRegistration();
    if (!registration.runtime)
      throw new Error('Git SCM test runtime is unavailable');
    const registry = createScmBackendRegistry([
      createRegisteredScmBackendAdapter({
        definition: { id: 'git', kind: 'git' },
        qualifiedId: 'happier.scm.git/git',
        executableDefinition: registration.runtime,
        registration,
        hostingProviderRuntimeServices:
          createScmHostingProviderRuntimeServicesForTest(
            makeProviderRegistry(makeCloneTargetDescription(remote)),
          ),
      }),
    ]);
    // Account HTTP is the boundary; row admission, materialization and Git stay real.
    const rows: unknown[] = [];
    const accountRows = createProjectAccountRowsHttpBoundary(rows);
    vi.spyOn(axios, 'get').mockImplementation(plainAccountRead);
    vi.spyOn(axios, 'post').mockImplementation(accountRows);
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const request = makeRequest(parent, remote, 'checkout');
    const input = {
      serverId: 'srv_test_home',
      machineId: 'machine',
      source: {
        kind: 'repository',
        selector: {
          provider: request.provider,
          repository: request.repository,
          protocol: request.protocol,
        },
      },
      subdir: 'not-in-the-repository',
      materialization: {
        kind: 'clone',
        destinationParentPath: parent,
        destinationDirectoryName: 'checkout',
      },
    } as OpenProjectInputV1;
    const context: RpcHandlerContext = {
      signal: new AbortController().signal,
      callerAuthority: 'present_user',
      machineAdmission: {
        actorAccountId: 'account',
        custodianAccountId: 'account',
        machineId: 'machine',
        installationId: 'installation',
        role: 'manage',
        encryptionMode: 'plain',
      },
      verifyMachineAdmissionCurrent: async () => true,
    };

    const result = await runWithRealGitScmRuntime(() =>
      openProject(
        input,
        {
          serverId: 'srv_test_home',
          serverHttpBaseUrl: 'https://home.example',
          machineId: 'machine',
          accountId: 'account',
          registry,
          readCredentials: async () => ({ token, encryption: null }),
        },
        context,
      ),
    );

    expect(result).toMatchObject({
      kind: 'refused',
      code: 'repository_subfolder_missing',
      effectAttempted: true,
    });
    expect(OpenProjectResultV1Schema.parse(result)).toEqual(result);
    await access(join(parent, 'checkout', '.git'));
    expect(rows).toEqual([]);
    // Fixing the field and retrying uses the clone it kept, without cloning again. Git's origin is the system
    // fact: the fixture's file:// remote stands in for the hosted URL a real clone records.
    const open = (next: OpenProjectInputV1) => runWithRealGitScmRuntime(() => openProject(next, { serverId: 'srv_test_home',
      serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account', registry,
      readCredentials: async () => ({ token, encryption: null }) }, context));
    const { subdir: _wrong, ...retryInput } = input;
    const checkout = join(parent, 'checkout');
    runGit(checkout, ['remote', 'set-url', 'origin', 'https://github.com/someone-else/another-repository.git']);
    expect(await open(retryInput as OpenProjectInputV1)).toMatchObject({ kind: 'refused', effectAttempted: false });
    expect(rows).toEqual([]);
    runGit(checkout, ['remote', 'set-url', 'origin', 'https://github.com/happier-dev/happier.git']);
    expect(await open(retryInput as OpenProjectInputV1)).toMatchObject({ kind: 'opened', directory: checkout });
    expect(rows.length).toBeGreaterThan(0);
  });
});
