import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import type { OpenProjectInputV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { openProject } from '@/workspaces/activation/openProject';
import { createProductionDaemonWorkspaceSyncRuntime } from './createProductionDaemonWorkspaceSyncRuntime';
import { createWorkspaceSyncNativeProcessTestBoundary } from './createProductionDaemonWorkspaceSyncRuntime.testkit';

it('routes admitted native Project Open through retained requester custody before host checkout preparation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-project-open-'));
  const serverId = 'srv_native_project_entry';
  await seedTestServerProfile({ id: serverId, homeId: serverId, serverUrl: 'https://native-open.invalid' });
  const native = createWorkspaceSyncNativeProcessTestBoundary();
  const rows: unknown[] = [];
  const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
  const post = vi.spyOn(axios, 'post').mockImplementation(createProjectAccountRowsHttpBoundary(rows));
  const token = [Buffer.from('{}').toString('base64url'), Buffer.from('{"sub":"owner"}').toString('base64url'), 'signature'].join('.');
  const credentials = { token, encryption: null };
  const runtime = await createProductionDaemonWorkspaceSyncRuntime({ happyHomeDir: directory,
    activeServerDir: join(directory, 'server'), activeServerId: serverId, localMachineId: 'host',
    releaseChannel: 'publicdev', credentials,
    callWorkspaceProjectSource: async () => { throw new Error('An unretained root must not reach the SOURCE transport'); },
  }, { ...native.factories, getProjectSnapshot: () => null, subscribeProjectSnapshot: () => () => {},
    resolveRootOwnershipDirectory: () => join(directory, 'locks') });
  onTestFinished(async () => { await runtime.stop(); get.mockRestore(); post.mockRestore();
    withdrawActiveProjectAccountRowsSnapshot(); await rm(directory, { recursive: true, force: true }); });
  const request: OpenProjectInputV1 = { serverId, machineId: 'host', source: { kind: 'workspace', workspaceId: 'source',
    checkout: { serverId, workspaceId: 'source', machineId: 'host', rootPath: '/selected/source' } },
    materialization: { kind: 'sync', targetPath: '/guest/retained',
      targetManaged: { managedId: 'sandbox', controller: { machineId: 'host', installationId: 'installation' } },
      workspaceAction: { kind: 'relationship', relationshipId: 'relationship', flushBeforeCommit: true } } };
  const context = { signal: new AbortController().signal, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'host',
      installationId: 'installation', role: 'use', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => true } satisfies import('@/api/rpc/types').RpcHandlerContext;
  const projectRuntime = { serverId, serverHttpBaseUrl: 'https://native-open.invalid', machineId: 'host', accountId: 'owner',
    readCredentials: async () => credentials, workspaceSyncAdapter: runtime.handoffAdapter,
    materializeManagedProjectTarget: runtime.materializeManagedProjectTarget };
  await expect(openProject(request, projectRuntime, context)).resolves.toMatchObject({ kind: 'refused', code: 'project_requester_authority_unavailable' });
  await expect(openProject(request, { ...projectRuntime, materializeManagedProjectTarget: undefined }, context))
    .resolves.toMatchObject({ kind: 'refused', code: 'workspace_sync_unavailable' });
  await expect(openProject(request, projectRuntime, { ...context, verifyMachineAdmissionCurrent: async () => false }))
    .resolves.toMatchObject({ kind: 'refused', code: 'machine_access_denied' });
  expect(rows).toEqual([]);
});
