import { expect, it } from 'vitest';
import { resolveAdmittedRepositoryWorkspace } from './admittedRepositoryWorkspace';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

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
