import { expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SESSION_PROJECT_FILES_OPEN_CHILDREN_V1 } from '@happier-dev/protocol/sessions/creation/sessionProjectFilesOpenV1';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { prepareEnrolledWorkspaceReturn as unscopedPrepareEnrolledWorkspaceReturn, prepareEnrolledWorkspaceReturnChildren } from './enrolledWorkspaceReturn';
import { scanWorkspaceManifest } from '@/scm/workspace/workspaceExportPackaging/scanWorkspaceManifest';
import { applyManagedWorkspaceReturn as unscopedApplyManagedWorkspaceReturn } from './managedWorkspaceReturn';
import { createScmBackendRegistry } from '@/scm/registry';
import { SESSION_WORKSPACE_RETURN_CAPTURE_CHILD_V1 } from '@happier-dev/protocol/actions/sessionWorkspaceReturnActionIdsV1';

import { runWithScmAccountScope } from '@/scm/accountScope';

function withAccount<Args extends readonly unknown[], Result>(effect: (...args: Args) => Result) {
  return (...args: Args): Result => runWithScmAccountScope('workspace-return-test-account', () => effect(...args));
}
const prepareEnrolledWorkspaceReturn = withAccount(unscopedPrepareEnrolledWorkspaceReturn);
const applyManagedWorkspaceReturn = withAccount(unscopedApplyManagedWorkspaceReturn);

it.each([false, true])('declares original-root admission and requester-private return stage (native=%s)', async native => {
  const sourceWorkspace = { serverId: 'home', machineId: 'original', workspaceId: 'host', rootPath: '/host/project' };
  const targetWorkspace = native ? { v: 2, kind: 'managed', serverId: 'home', workspaceId: 'guest', rootPath: '/sandbox/project',
    managedId: 'guest', controller: { machineId: 'sandbox', installationId: 'installation' } }
    : { serverId: 'home', machineId: 'sandbox', workspaceId: 'guest', rootPath: '/sandbox/project' };
  const prepared = await prepareEnrolledWorkspaceReturnChildren({ sessionId: 'session', machineId: 'original',
    readRequesterWorkspaceScope: async () => ({ kind: 'available', homeDir: '/requester', workspaceRoot: '/requester/workspaces' }),
    actionRequestId: 'return-request', activeServerDir: '/private/daemon', metadata: { sessionCreationCorrespondenceV1: {
      v: 1, sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'created' }), recipe: {
        execution: { machineId: 'sandbox', directory: { kind: 'path', path: targetWorkspace.rootPath } },
        organization: { folderId: null, tagIds: [] }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null, configuration: null,
        connectedServices: null, capabilitySelection: null, transcriptStorage: null, terminal: null,
        agentSessionStartupInstructionsMarkerV1: null, checkout: null, projectFilesOrigin: { sourceWorkspace, targetWorkspace },
      },
    } } });
  expect(prepared).not.toBeNull();
  expect(prepared!.children[0]).toMatchObject({ action: 'projects.open', input: { machineId: 'original',
    source: { kind: 'workspace', checkout: sourceWorkspace }, materialization: { kind: 'attach' } } });
  if (native) {
    expect(prepared!.children[1]).toMatchObject({ ...SESSION_WORKSPACE_RETURN_CAPTURE_CHILD_V1,
      input: { sessionId: 'session', machineId: 'sandbox' } });
    expect(prepared!.children[2]).toMatchObject({ action: 'projects.open', scopeInput: { serverId: 'home', machineId: 'original' } });
  } else expect(prepared!.children[1]).toMatchObject({ action: 'projects.open', input: { machineId: 'original',
      source: { kind: 'workspace', checkout: targetWorkspace }, materialization: { kind: 'sync',
        workspaceAction: { kind: 'copy_once', contentPolicy: { contentOnly: true, selection: 'git_worktree' } } } } });
  expect(prepared!.targetPath).toContain('/requester/workspaces/');
});

it('admits Bring changes back to the original managed Project address', async () => {
  const controller = { machineId: 'controller', installationId: 'installation' };
  const sourceWorkspace = { v: 2, kind: 'managed', serverId: 'home', workspaceId: 'original',
    managedId: 'guest', rootPath: '/project', controller };
  const targetWorkspace = { serverId: 'home', machineId: controller.machineId, workspaceId: 'copy', rootPath: '/copies/project' };
  const metadata = { sessionCreationCorrespondenceV1: { v: 1,
    sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'created' }), recipe: {
      execution: { machineId: controller.machineId, directory: { kind: 'path', path: targetWorkspace.rootPath } },
      organization: { folderId: null, tagIds: [] }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null, configuration: null,
      connectedServices: null, capabilitySelection: null, transcriptStorage: null, terminal: null,
      agentSessionStartupInstructionsMarkerV1: null, checkout: null, projectFilesOrigin: { sourceWorkspace, targetWorkspace },
    } } };
  const prepare = (machineId: string) => prepareEnrolledWorkspaceReturnChildren({ sessionId: 'session', machineId, metadata,
    activeServerDir: '/private/daemon', actionRequestId: 'return-request',
    readRequesterWorkspaceScope: async () => ({ kind: 'available', homeDir: '/requester', workspaceRoot: '/requester/workspaces' }) });
  await expect(prepare('another-controller')).rejects.toMatchObject({ code: 'target_mismatch' });
  await expect(prepare(controller.machineId)).resolves.toMatchObject({
    origin: { sourceWorkspace },
    children: expect.arrayContaining([{ ...SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source,
      input: expect.objectContaining({ machineId: controller.machineId,
        source: { kind: 'workspace', workspaceId: sourceWorkspace.workspaceId, checkout: sourceWorkspace },
        materialization: { kind: 'attach' },
      }),
    }]),
  });
});

it.each([false, true])('reviews enrolled changes against the copied base and keeps host edits (native=%s)', async native => {
  const root = await mkdtemp(join(tmpdir(), 'enrolled-return-'));
  const hostRoot = join(root, 'host'); const sandboxRoot = join(root, 'sandbox');
  await mkdir(hostRoot); await mkdir(sandboxRoot);
  await writeFile(join(hostRoot, 'both.txt'), 'base both\n');
  await writeFile(join(hostRoot, 'agent.txt'), 'base agent\n');
  await writeFile(join(hostRoot, 'local.env'), 'copied private local values\n');
  const registry = createScmBackendRegistry([]);
  const baseline = await scanWorkspaceManifest({ workspaceRoot: hostRoot, scmRegistry: registry, safeFilterPolicy: { excludeAdministrativePaths: true } });
  await writeFile(join(hostRoot, 'both.txt'), 'person edit\n');
  await writeFile(join(sandboxRoot, 'both.txt'), 'sandbox edit\n');
  await writeFile(join(sandboxRoot, 'agent.txt'), 'committed agent content\n');
  const sourceWorkspace = { serverId: 'home', machineId: 'original', workspaceId: 'host', rootPath: hostRoot };
  const targetWorkspace = native ? { v: 2, kind: 'managed', serverId: 'home', workspaceId: 'guest', rootPath: sandboxRoot,
    managedId: 'guest', controller: { machineId: 'sandbox', installationId: 'installation' } }
    : { serverId: 'home', machineId: 'sandbox', workspaceId: 'guest', rootPath: sandboxRoot };
  const metadata = { sessionCreationCorrespondenceV1: { v: 1,
    sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'created' }), recipe: {
      execution: { machineId: 'sandbox', directory: { kind: 'path', path: sandboxRoot } },
      organization: { folderId: null, tagIds: [] }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null, configuration: null,
      connectedServices: null, capabilitySelection: null, transcriptStorage: null, terminal: null,
      agentSessionStartupInstructionsMarkerV1: null, checkout: null, projectFilesOrigin: { sourceWorkspace, targetWorkspace, baseline },
    } } };
  const prepared = await prepareEnrolledWorkspaceReturnChildren({ sessionId: 'session', machineId: 'original',
    metadata, activeServerDir: root, actionRequestId: 'return-request',
    readRequesterWorkspaceScope: async () => ({ kind: 'available', homeDir: root, workspaceRoot: null }) });
  if (!prepared) throw new Error('expected enrolled return origin');
  try {
    const preview = await prepareEnrolledWorkspaceReturn({ sessionId: 'session', activeServerDir: root, prepared, registry,
      // Project Open is the enrolled Machine transport boundary; review capture and apply remain real.
      invokeReviewedChild: async child => {
        if (child.action === SESSION_WORKSPACE_RETURN_CAPTURE_CHILD_V1.action) {
          expect(child.input).toEqual({ sessionId: 'session', machineId: 'sandbox' });
          return { ok: true, result: { workspace: { serverId: 'home', machineId: 'sandbox', workspaceId: 'private-stage',
            rootPath: sandboxRoot }, baseline, excludedPaths: ['local.env'] } };
        }
        const request = OpenProjectInputV1Schema.parse(child.input);
        if (request.materialization.kind === 'attach') return { ok: true, result: {
          kind: 'opened', directory: hostRoot, workspace: sourceWorkspace, setup: 'notRequired',
        } };
        // Only the admitted Project owner may create the requester-private destination.
        if (native) expect(request.source).toMatchObject({ kind: 'workspace', checkout: { machineId: 'sandbox', workspaceId: 'private-stage' } });
        await expect(stat(prepared.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await cp(sandboxRoot, prepared.targetPath, { recursive: true });
        return { ok: true, result: { kind: 'opened', directory: prepared.targetPath,
          workspace: { ...sourceWorkspace, workspaceId: 'stage', rootPath: prepared.targetPath }, setup: 'notRequired',
          copyOnceExcludedPaths: native ? [] : ['local.env'] } };
      },
    });
    if ('ok' in preview) throw new Error(`return failed: ${preview.errorCode}`);
    expect(preview.applyUnavailableReason).toBeUndefined();
    expect(preview.paths.some(path => path.path === 'local.env')).toBe(false);
    expect(preview.paths.flatMap(path => path.conflicts)).toEqual([{ path: 'both.txt', code: 'both_changed' }]);
    expect(preview.paths.find(path => path.path === 'agent.txt')?.files[0]?.evidence).toMatchObject({
      state: 'available', unifiedDiff: expect.stringContaining('+committed agent content'),
    });
    await applyManagedWorkspaceReturn({ sessionId: 'session', returnId: preview.returnId,
      activeServerDir: root, paths: ['both.txt', 'agent.txt'] });
    expect(await readFile(join(hostRoot, 'both.txt'), 'utf8')).toBe('person edit\n');
    expect(await readFile(join(hostRoot, 'agent.txt'), 'utf8')).toBe('committed agent content\n');
    expect(await readFile(join(hostRoot, 'local.env'), 'utf8')).toBe('copied private local values\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
