import { expect, it } from 'vitest';
import { resolveAdmittedRepositoryWorkspace } from './admittedRepositoryWorkspace';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

it.each(['exact', 'another Source', 'stale revision', 'another repository', 'repository only'] as const)(
  'admits a repository checkout only for the requested Source pin: %s', async variant => {
    const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/repo' };
    const workspace: WorkspaceRefV1 = { id: 'checkout', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
      repositoryIdentity: variant === 'another repository' ? { ...repository, repository: 'owner/other' } : repository,
      ...(variant === 'repository only' ? {} : { source: { sourceId: variant === 'another Source' ? 'other' : 'source',
        revision: variant === 'stale revision' ? 1 : 2 } }) };
    const result = await resolveAdmittedRepositoryWorkspace({
      workspace: { kind: 'workspace-ref', serverId: 'home', id: workspace.id }, context: { serverId: 'home' },
      expected: { projectSourceId: 'source', sourceRevision: 2, repository }, fallbackActionId: 'deployments.prepare',
      readWorkspaceRows: async () => ({ workspaceRefs: [workspace], relationships: [], source: 'network' as const,
        organizations: [], rows: [], graphRevision: 'absent' as const, loadedAtMs: 1, scopeKey: 'scope' }),
    });
    expect(result).toMatchObject(variant === 'exact' ? { kind: 'resolved', workspace }
      : { kind: 'conflict', reason: 'source_changed' });
  });

it('resolves an admitted canonical target against alias rows, refusing ambiguous or foreign rows', async () => {
  let refs: WorkspaceRefV1[] = [{ id: 'workspace', serverId: 'alias', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 }];
  const input = { workspace: { kind: 'workspace-ref' as const, serverId: 'canonical-home', id: 'workspace' },
    context: { serverId: 'alias', serverIdentityId: 'canonical-home' }, fallbackActionId: 'deployments.prepare',
    readWorkspaceRows: async () => ({ workspaceRefs: refs, relationships: [], source: 'network' as const,
      organizations: [], rows: [], graphRevision: 'absent' as const, loadedAtMs: 1, scopeKey: 'scope' }) };
  expect(await resolveAdmittedRepositoryWorkspace(input)).toMatchObject({ kind: 'resolved', workspace: { serverId: 'canonical-home', machineId: 'machine' } });
  refs = [...refs, { ...refs[0]!, serverId: 'canonical-home' }];
  expect(await resolveAdmittedRepositoryWorkspace(input)).toEqual({ kind: 'refused', reason: 'workspace_unavailable' });
  refs = [{ ...refs[0]!, serverId: 'foreign' }];
  expect(await resolveAdmittedRepositoryWorkspace(input)).toEqual({ kind: 'refused', reason: 'workspace_unavailable' });
});
