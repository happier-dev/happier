import axios from 'axios';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

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

  it.each(['clone-failed', 'native-auth-refused', 'subfolder-missing'] as const)('writes no Project for %s and retains only completed clones', async failure => {
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
            makeProviderRegistry(makeCloneTargetDescription(failure === 'clone-failed' ? join(remote, 'missing.git') : remote),
              failure === 'native-auth-refused' ? { describeCloneTargets: async () => {
                // The provider is the external boundary; its typed refusal must survive the real SCM and Project owners.
                throw new PluginError({ code: 'plugin_connected_account_native_unavailable',
                  message: 'native output https://secret@example.invalid/private',
                  remediation: { kind: 'selectAccount', service: {
                    pluginId: 'happier.scm.forge.github', localId: 'github',
                  } } });
              } } : undefined),
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

    if (failure === 'clone-failed' || failure === 'native-auth-refused') {
      expect(result).toMatchObject({ kind: 'refused',
        code: failure === 'clone-failed' ? 'REMOTE_NOT_FOUND' : 'REMOTE_AUTH_REQUIRED', effectAttempted: false });
      if (failure === 'native-auth-refused') {
        expect(result).toMatchObject({ failureCause: { phase: 'scm.hosting_provider',
          errorCode: 'plugin_connected_account_native_unavailable' }, remediation: { kind: 'auth_required' } });
        expect(JSON.stringify(result)).not.toContain('secret@example.invalid');
      }
      await expect(access(join(parent, 'checkout'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(rows).toEqual([]);
      return;
    }
    expect(result).toMatchObject({
      kind: 'refused',
      code: 'repository_subfolder_missing',
      effectAttempted: true,
    });
    expect(OpenProjectResultV1Schema.parse(result)).toEqual(result);
    await access(join(parent, 'checkout', '.git'));
    expect(rows).toEqual([]);
    // A folder already at the clone's destination is never taken over, even a checkout of this same repository
    // (COR4B 11-15: a new deploy adopted another lane's checkout and fetched in it). The refusal names the folder;
    // the person picks another name, or opens that folder as it is. Git's origin is the system fact: the fixture's
    // file:// remote stands in for the hosted URL a real clone records.
    const open = (next: OpenProjectInputV1) => runWithRealGitScmRuntime(() => openProject(next, { serverId: 'srv_test_home',
      serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account', registry,
      readCredentials: async () => ({ token, encryption: null }) }, context));
    const { subdir: _wrong, ...retryInput } = input;
    const checkout = join(parent, 'checkout');
    for (const origin of ['https://github.com/someone-else/another-repository.git', 'https://github.com/happier-dev/happier.git']) {
      runGit(checkout, ['remote', 'set-url', 'origin', origin]);
      expect(await open(retryInput as OpenProjectInputV1)).toMatchObject({ kind: 'refused', code: 'destination_exists',
        effectAttempted: false });
      expect(rows).toEqual([]);
    }
    expect(await open({ ...(retryInput as OpenProjectInputV1), source: { kind: 'folder', path: checkout },
      materialization: { kind: 'attach' } } as OpenProjectInputV1)).toMatchObject({ kind: 'opened', directory: checkout });
    expect(rows.length).toBeGreaterThan(0);
  });
});
