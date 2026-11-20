import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ScmRepositoryCloneSourceV1 } from '@happier-dev/protocol/scm/repositoryClone';
import type { OpenProjectInputV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SESSION_PROJECT_FILES_OPEN_CHILDREN_V1 } from '@happier-dev/protocol/sessions/creation/sessionProjectFilesOpenV1';
import type { SessionProjectFilesV1 } from '@happier-dev/protocol/sessions/creation/sessionPlacementSelectionV1';
import { prepareEnrolledSessionProjectFiles } from './prepareEnrolledSessionProjectFiles';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

const target = { serverId: 'home', machineId: 'remote' };
const source = { target: { serverId: 'home', machineId: 'original' }, directory: '/chosen/dirty-project' };
const sourceWorkspace = { serverId: 'home', workspaceId: 'original-workspace', machineId: 'original', rootPath: source.directory };
const targetWorkspace = { serverId: 'home', workspaceId: 'remote-workspace', machineId: 'remote', rootPath: '/remote/managed/new-session' };
const context: ActionExecutorContext = { authority: 'present_user', surface: 'ui', serverId: 'home',
  runtimeAccountId: 'owner', actionRequestId: 'copy-draft', actionCaller: { kind: 'host' }, bypassApprovals: true,
  actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };

const cloneSource = { source: { provider: { id: 'happier.scm.forge.github/github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' },
  repository: { nameWithOwner: 'owner/original' }, protocol: 'https' as const }, branch: 'feature/original' };

async function run(choice?: SessionProjectFilesV1, sourceRefusal?: string, facts: ScmRepositoryCloneSourceV1 = cloneSource) {
  const requests: OpenProjectInputV1[] = [];
  const input = SessionSpawnNewInputV2Schema.parse({ executionTarget: target,
    directory: { kind: 'path', path: source.directory },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    sessionPlacement: { kind: 'machine', target, projectFilesSource: source, ...(choice ? { projectFiles: choice } : {}) },
  });
  const executor = createActionExecutor({
    // Machine Project Open dispatch is the network boundary. Reviewed child
    // declarations, authorization scope, normalization and Session orchestration stay real.
    projectsOpen: async request => {
      requests.push(request);
      if (request.machineId === source.target.machineId && sourceRefusal) return { kind: 'refused', code: sourceRefusal };
      const workspace = request.machineId === source.target.machineId ? sourceWorkspace : targetWorkspace;
      return { kind: 'opened', workspace, directory: request.materialization.kind === 'clone'
        ? `${targetWorkspace.rootPath}/repository` : workspace.rootPath, setup: 'notRequired', ...(request.machineId === source.target.machineId && 'cloneSource' in request ? { cloneSource: facts } : {}) };
    },
    sessionSpawnNew: async args => {
      if (!choice || choice.kind !== 'git_clone' || !choice.source || !choice.branch) {
        // Spawn authority on the remote Machine cannot substitute another source.
        const unauthorizedSource = await args.context!.hostReviewedChild!.invoke({
          ...SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source,
          input: projectNativeJsonValueForTransport({ serverId: 'home', machineId: 'another-persons-machine',
            source: { kind: 'folder', path: source.directory }, materialization: { kind: 'attach' } }),
        });
        expect(unauthorizedSource).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
        for (const extra of [{ subdir: 'another-folder' }, { source: { kind: 'folder', path: '/another-folder' } }]) {
          expect(await args.context!.hostReviewedChild!.invoke({ ...SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source,
            input: projectNativeJsonValueForTransport({ ...source.target, source: { kind: 'folder', path: source.directory },
              materialization: { kind: 'attach' }, cloneSource: true, ...extra }),
          })).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
        }
      }
      const prepared = await prepareEnrolledSessionProjectFiles({ placement: args.sessionPlacement,
        executionTarget: args.executionTarget, targetDirectory: targetWorkspace.rootPath,
        invokeReviewedChild: args.context!.hostReviewedChild!.invoke });
      if (!prepared.ok) return prepared;
      expect(prepared).toMatchObject({ directory: choice?.kind === 'git_clone'
        ? `${targetWorkspace.rootPath}/repository` : targetWorkspace.rootPath, workspace: targetWorkspace });
      if (choice?.kind !== 'git_clone') expect(prepared.sourceWorkspace).toEqual(sourceWorkspace);
      return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' };
    },
  });
  return { result: await executor.execute('session.spawn_new', input, context), requests };
}

describe('enrolled remote Session Project files', () => {
  it.each(['copy_once', 'sync'] as const)('uses the selected Included policy through reviewed %s materialization', async kind => {
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: ['private/**'], extraIncludePatterns: ['build/result.txt'] };
    const contentPolicy = { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) };
    const choice: SessionProjectFilesV1 = kind === 'copy_once' ? { kind, contentPolicy }
      : { kind, mode: 'keep_both_in_sync', contentPolicy };
    const { result, requests } = await run(choice);
    expect(result).toMatchObject({ ok: true });
    expect(requests[1]).toMatchObject({ materialization: { kind: 'sync', workspaceAction: { contentPolicy } } });
  });
  it('copies the captured source through Project Open and starts in the materialized target, without a persistent relationship', async () => {
    const { result, requests } = await run();
    expect(result).toMatchObject({ ok: true, result: { type: 'pending' } });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ machineId: 'original', source: { kind: 'folder', path: source.directory },
      materialization: { kind: 'attach' } });
    expect(requests[1]).toMatchObject({ machineId: 'remote', source: { kind: 'workspace', checkout: sourceWorkspace },
      materialization: { kind: 'sync', targetPath: targetWorkspace.rootPath,
        workspaceAction: { kind: 'copy_once', contentPolicy: { selection: 'git_worktree' } } } });
  });

  it('materializes a guest copy on its controller and retains the guest for Bring changes back', async () => {
    const workspace = {
      v: 2, kind: 'managed', serverId: target.serverId, workspaceId: 'guest-ref', managedId: 'guest-id',
      controller: { machineId: target.machineId, installationId: 'guest-controller' },
      rootPath: targetWorkspace.rootPath,
    } as const;
    const input = SessionSpawnNewInputV2Schema.parse({
      executionTarget: target,
      directory: { kind: 'path', path: targetWorkspace.rootPath },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      sessionPlacement: {
        kind: 'machine', target, projectFilesSource: { kind: 'managed', workspace },
        projectFiles: { kind: 'copy_once' },
      },
    });
    const requests: OpenProjectInputV1[] = [];
    const executor = createActionExecutor({
      projectsOpen: async request => {
        requests.push(request);
        return {
          kind: 'opened', workspace: request.materialization.kind === 'attach' ? workspace : targetWorkspace,
          directory: targetWorkspace.rootPath, setup: 'notRequired',
        };
      },
      sessionSpawnNew: async args => {
        const prepared = await prepareEnrolledSessionProjectFiles({
          placement: args.sessionPlacement, executionTarget: args.executionTarget,
          targetDirectory: targetWorkspace.rootPath, invokeReviewedChild: args.context?.hostReviewedChild?.invoke,
        });
        if (!prepared.ok) return prepared;
        expect(prepared.projectFilesOrigin).toMatchObject({ sourceWorkspace: workspace, targetWorkspace });
        return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' };
      },
    });
    await expect(executor.execute('session.spawn_new', input, context)).resolves.toMatchObject({
      ok: true, result: { type: 'pending' },
    });
    expect(requests).toMatchObject([
      { ...target, source: { kind: 'workspace', workspaceId: workspace.workspaceId, checkout: workspace },
        materialization: { kind: 'attach' } },
      { ...target, source: { kind: 'workspace', workspaceId: workspace.workspaceId, checkout: workspace },
        materialization: { kind: 'sync', workspaceAction: { kind: 'copy_once' } } },
    ]);
  });

  it('stops before target materialization when the source Machine refuses admission', async () => {
    const { result, requests } = await run(undefined, 'machine_access_denied');
    expect(result).toMatchObject({ ok: false, errorCode: 'machine_access_denied' });
    expect(requests.map(request => request.machineId)).toEqual(['original']);
  });

  it.each(['keep_synced', 'keep_both_in_sync'] as const)('uses the incumbent persistent relationship for %s', async mode => {
    const { result, requests } = await run({ kind: 'sync', mode });
    expect(result).toMatchObject({ ok: true });
    expect(requests[1].materialization).toMatchObject({ kind: 'sync', workspaceAction: {
      kind: 'create_relationship', mode, flushBeforeCommit: true,
    } });
  });


  it.each(['both', 'repository', 'branch'] as const)('resolves deferred %s from the admitted original folder before cloning', async deferred => {
    const { result, requests } = await run({ kind: 'git_clone',
      ...(deferred === 'branch' ? { source: cloneSource.source } : {}),
      ...(deferred === 'repository' ? { branch: 'chosen/branch' } : {}),
    });
    expect(result).toMatchObject({ ok: true });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ machineId: 'original', source: { kind: 'folder', path: source.directory },
      materialization: { kind: 'attach' }, cloneSource: true });
    expect(requests[1]).toMatchObject({ source: { kind: 'repository', selector: cloneSource.source },
      materialization: { initialCheckout: { branch: deferred === 'repository' ? 'chosen/branch' : cloneSource.branch } } });
  });

  it.each([
    { facts: { source: null, branch: 'main' }, code: 'source_unavailable' },
    { facts: { source: cloneSource.source, branch: null }, code: 'ref_unavailable' },
  ])('refuses unavailable inherited clone facts with $code before target effects', async ({ facts, code }) => {
    const { result, requests } = await run({ kind: 'git_clone' }, undefined, facts);
    expect(result).toMatchObject({ ok: false, errorCode: code });
    expect(requests.map(request => request.machineId)).toEqual(['original']);
  });

  it('retains source refusal and never materializes a target for deferred clone', async () => {
    const { result, requests } = await run({ kind: 'git_clone' }, 'workspace_managed_target_required');
    expect(result).toMatchObject({ ok: false, errorCode: 'workspace_managed_target_required' });
    expect(requests.map(request => request.machineId)).toEqual(['original']);
  });

  it('clones the selected branch inside the target with connected Account authentication and no local source read', async () => {
    const gitAccount = { service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: 'work' };
    const { result, requests } = await run({ kind: 'git_clone', branch: 'feature/project-files', gitAccount, source: {
      provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'owner/project', cloneUrl: 'https://github.com/owner/project.git' }, protocol: 'ssh',
    } });
    expect(result).toMatchObject({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ machineId: 'remote', source: { kind: 'repository', selector: { protocol: 'https' } },
      materialization: { kind: 'clone', destinationParentPath: targetWorkspace.rootPath,
        destinationDirectoryName: 'repository', initialCheckout: { branch: 'feature/project-files' }, authentication: 'connected_account', gitAccount } });
  });
});
