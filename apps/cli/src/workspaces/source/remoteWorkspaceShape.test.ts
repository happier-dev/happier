import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { registerSessionTargetWorkspace, resolveSessionTargetWorkspace } from '@/daemon/sessions/sessionTargetWorkspaces';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';

import { readWorkspaceSourcePlacement } from './workspaceSource';

const managedWorkspace = {
  v: 2 as const,
  kind: 'managed' as const,
  workspaceId: 'project-workspace',
  serverId: 'home',
  managedId: 'coder-workspace',
  controller: { machineId: 'controller', installationId: 'controller-installation' },
  rootPath: '/home/coder/project',
};

describe('remote workspace shape contracts', () => {
  it('R1: admission retains the managed workspace address', () => {
    const placement = readWorkspaceSourcePlacement(undefined, {
      rootPath: managedWorkspace.rootPath,
      workspace: managedWorkspace,
    });

    expect(placement).toEqual({ rootPath: managedWorkspace.rootPath, workspace: managedWorkspace });
  });

  it('R61-1: a managed request cannot read the controller folder after its Session target ends', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'retired-session-workspace-'));
    const sentinel = join(rootPath, 'controller-only');
    const lifetime = new AbortController();
    const sessionId = 'retired-target-session';
    try {
      await writeFile(sentinel, 'controller bytes');
      registerSessionTargetWorkspace({
        sessionId, lifetime: lifetime.signal, primarySocketPath: join(rootPath, 'holder.sock'),
        workspace: { hostRoot: rootPath, targetRoot: rootPath },
        target: {
          id: `managed:${managedWorkspace.managedId}`, lifetime: lifetime.signal,
          holderPath: '/fixture/holder', helperPath: '/fixture/helper', socketDirectory: rootPath,
          exec: () => { throw new Error('Unexpected guest exec'); },
          openChannel: () => { throw new Error('Unexpected guest channel'); },
        },
      });
      lifetime.abort();

      const admission = createFilesystemEffectAdmission({ resolveWorkspaceTarget: resolveSessionTargetWorkspace });
      const context = { authorization: { kind: 'session.write', sessionId } };
      await expect(admission.selectWorkspaceSource(undefined, { rootPath }).readFile(sentinel))
        .resolves.toEqual(Buffer.from('controller bytes'));
      await expect(async () => {
        return await admission.selectWorkspaceSource(context, { rootPath, workspace: { ...managedWorkspace, rootPath } }).readFile(sentinel);
      }).rejects.toMatchObject({ code: 'workspace_target_unavailable' });
    } finally {
      lifetime.abort();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
