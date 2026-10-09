import { describe, expect, it } from 'vitest';

import { ProjectKeyV1Schema, WorkspaceRefV1Schema } from './workspaceRefV1.js';
import { resolveWorkspaceRefV1, enrichWorkspaceRefV1, projectWorkspaceRefV1 } from './workspaceRefResolutionV1.js';

describe('workspaceRefV1', () => {
  it('resolves exact Home addresses and preserves ambiguity across Homes and duplicate scopes', () => {
    const refs = ['a', 'b'].map(serverId => ({ id: 'same', serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1 }));
    expect(resolveWorkspaceRefV1(refs, { id: 'same' })).toEqual({ kind: 'ambiguous', candidates: refs });
    expect(resolveWorkspaceRefV1(refs, { serverId: 'b', workspaceId: 'same', machineId: 'machine', rootPath: '/repo/' })).toEqual({ kind: 'resolved', ref: refs[1] });
    expect(resolveWorkspaceRefV1(refs, { serverId: 'b', workspaceId: 'same', machineId: 'machine', rootPath: '/other' }).kind).toBe('missing');
    const duplicate = { ...refs[0]!, id: 'other' };
    expect(resolveWorkspaceRefV1([...refs, duplicate], { serverId: 'a', machineId: 'machine', rootPath: '/repo' })).toEqual({ kind: 'ambiguous', candidates: [refs[0], duplicate] });
    expect(resolveWorkspaceRefV1(refs, { serverId: 'a', projectKey: 'same' }).kind).toBe('invalid');
  });

  it('compares mixed Windows paths exactly without aliasing sibling homes or folding POSIX case', () => {
    const ref = { id: 'ref', serverId: 'home', machineId: 'machine', rootPath: 'C:\\Users\\alice\\Repo\\', createdAtMs: 1 };
    expect(resolveWorkspaceRefV1([ref], { serverId: 'home', machineId: 'machine', rootPath: 'c:/users/alice/repo' }).kind).toBe('resolved');
    expect(resolveWorkspaceRefV1([ref], { serverId: 'home', machineId: 'machine', rootPath: 'C:/Users/alice2/Repo' }).kind).toBe('missing');
    expect(resolveWorkspaceRefV1([{ ...ref, rootPath: 'C:\\' }], { serverId: 'home', machineId: 'machine', rootPath: 'c:/' }).kind).toBe('resolved');
    expect(resolveWorkspaceRefV1([{ ...ref, rootPath: '/Repo' }], { serverId: 'home', machineId: 'machine', rootPath: '/repo' }).kind).toBe('missing');
  });

  it('retains fallback anchors through enrichment and Source provenance', () => {
    const ref = { id: 'anchor', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
    const enriched = enrichWorkspaceRefV1(ref, { source: { sourceId: 'source', revision: 1 } });
    expect(projectWorkspaceRefV1(enriched)).toEqual(projectWorkspaceRefV1(ref));
    expect(projectWorkspaceRefV1(enrichWorkspaceRefV1({ ...ref, projectKey: 'existing' }, { projectKey: 'replacement' }))).toEqual({ serverId: 'home', projectKey: 'existing' });
  });
  it('parses WorkspaceRefV1 as a forward-compatible workspace reference', () => {
    const parsed = WorkspaceRefV1Schema.parse({
      id: 'workspace_1',
      serverId: 'server_1',
      machineId: 'machine_1',
      rootPath: '/repo',
      label: 'Repo',
      createdAtMs: 1,
      lastOpenedAtMs: null,
      futureField: { keep: true },
    });
    expect(parsed).not.toHaveProperty('futureField');

    expect(parsed).toMatchObject({
      id: 'workspace_1',
      serverId: 'server_1',
      machineId: 'machine_1',
      rootPath: '/repo',
      label: 'Repo',
      createdAtMs: 1,
      lastOpenedAtMs: null,
    });
  });

  it('preserves stored workspace reference string fields without normalization', () => {
    const parsed = WorkspaceRefV1Schema.parse({
      id: ' workspace_1 ',
      serverId: ' server_1 ',
      machineId: ' machine_1 ',
      rootPath: ' /repo with spaces ',
      label: ' Repo ',
      createdAtMs: 1,
      lastOpenedAtMs: null,
    });

    expect(parsed).toMatchObject({
      id: ' workspace_1 ',
      serverId: ' server_1 ',
      machineId: ' machine_1 ',
      rootPath: ' /repo with spaces ',
      label: ' Repo ',
    });
  });

  it('accepts only id or scope tuple project lookup keys', () => {
    expect(ProjectKeyV1Schema.parse({ id: 'workspace_1' })).toEqual({ id: 'workspace_1' });
    expect(ProjectKeyV1Schema.parse({
      serverId: 'server_1',
      machineId: 'machine_1',
      rootPath: '/repo',
    })).toEqual({
      serverId: 'server_1',
      machineId: 'machine_1',
      rootPath: '/repo',
    });
    expect(ProjectKeyV1Schema.safeParse({ serverId: 'server_1', machineId: 'machine_1' }).success).toBe(false);
  });

  it('admits a Home-qualified presentation anchor separately from an exact checkout', () => {
    expect(ProjectKeyV1Schema.safeParse({ serverId: 'home', projectKey: 'anchor' }).success).toBe(true);
    expect(ProjectKeyV1Schema.safeParse({ serverId: 'home', id: 'checkout' }).success).toBe(true);
    expect(ProjectKeyV1Schema.safeParse({ projectKey: 'anchor' }).success).toBe(false);
  });

  it('drops unknown stored facts recursively while refusing malformed known identity', () => {
    const ref = { id: 'checkout', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
      projectKey: 'anchor', repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo', extra: true },
      source: { sourceId: 'source', revision: 2, extra: true }, extra: true };
    const { extra: _extra, ...known } = ref;
    expect(WorkspaceRefV1Schema.parse(ref)).toEqual({ ...known,
      repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' },
      source: { sourceId: 'source', revision: 2 } });
    expect(WorkspaceRefV1Schema.safeParse({ ...ref, source: { sourceId: 'source', revision: -1 } }).success).toBe(false);
  });
});
