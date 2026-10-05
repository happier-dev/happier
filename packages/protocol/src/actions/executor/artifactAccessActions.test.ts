import { describe, expect, it, vi } from 'vitest';
import { createArtifactAccessActionsV1 } from './artifactAccessActions.js';
import type { ArtifactSharingResourceV1 } from '../../artifacts/artifactSharingV1.js';
import { createWorkBoardV1 } from '../../boards/workBoardV1.js';
import { buildWorkBoardArtifactHeaderV1 } from '../../boards/workBoardArtifactV1.js';

const input = { artifactId: 'workflow', principal: { kind: 'team' as const, teamId: 'team' }, accessLevel: 'edit' as const };
const resource = { artifactId: 'workflow', access: 'owner' as const,
  header: { kind: 'workflow-definition.v1', definitionId: 'workflow', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Workflow' } },
  revision: { headerVersion: 1, bodyVersion: 1 } };
const response = { artifactId: 'workflow', ownerAccountId: 'owner', access: 'owner' as const, grants: [], changed: true };

describe('Artifact grant host owner', () => {
  it('returns a committed self-revocation after checking pre-mutation admin authority', async () => {
    const revoked = { ...response, access: null };
    let opened: ArtifactSharingResourceV1 | null = { ...resource, access: 'admin' };
    const owner = createArtifactAccessActionsV1({ read: async () => opened,
      transport: { list: async () => response, set: async () => response,
        remove: async () => { opened = null; return revoked; } } });
    const invocation = { actionId: 'artifact.access.grants.remove' as const,
      input: { artifactId: input.artifactId, principal: input.principal } };
    await expect(owner(invocation)).resolves.toEqual(revoked);
    await expect(owner(invocation)).rejects.toMatchObject({ code: 'artifact_not_found' });
  });

  it('validates the opened kind and owner/admin authority before a storage mutation, while allowing grantees to list', async () => {
    const write = vi.fn(async () => response);
    const { changed: _changed, ...listed } = response;
    let opened: ArtifactSharingResourceV1 = resource;
    const owner = createArtifactAccessActionsV1({ read: async () => opened,
      transport: { list: async () => listed, set: write, remove: write } });
    await expect(owner({ actionId: 'artifact.access.grants.set', input })).resolves.toEqual(response);
    opened = { ...resource, access: 'admin' };
    await expect(owner({ actionId: 'artifact.access.grants.set', input })).resolves.toEqual(response);
    opened = { ...resource, access: 'edit' };
    await expect(owner({ actionId: 'artifact.access.grants.set', input })).rejects.toMatchObject({ code: 'artifact_access_forbidden' });
    await expect(owner({ actionId: 'artifact.access.grants.list', input: { artifactId: 'workflow' } })).resolves.toEqual(listed);
    opened = { ...resource, header: { ...resource.header, revision: { headerVersion: 99, bodyVersion: 1 } } };
    await expect(owner({ actionId: 'artifact.access.grants.set', input })).rejects.toMatchObject({ code: 'artifact_kind_not_shareable' });
    const { access: _access, ...predecessor } = resource;
    opened = predecessor;
    await expect(owner({ actionId: 'artifact.access.grants.set', input })).rejects.toMatchObject({ code: 'artifact_access_unavailable' });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('shares every ordinary opened document kind while retaining grant authority checks', async () => {
    let opened: ArtifactSharingResourceV1 = { ...resource, header: { kind: 'published.v1', title: 'Report' } };
    const owner = createArtifactAccessActionsV1({ read: async () => opened,
      transport: { list: async () => response, set: async () => response, remove: async () => response } });
    await expect(owner({ actionId: 'artifact.access.grants.set', input })).resolves.toEqual(response);
    opened = { ...opened, header: { title: 'Predecessor text document' } };
    await expect(owner({ actionId: 'artifact.access.grants.set', input })).resolves.toEqual(response);
    opened = { ...opened, access: 'view' };
    await expect(owner({ actionId: 'artifact.access.grants.set', input })).rejects.toMatchObject({ code: 'artifact_access_forbidden' });
  });

  it('uses canonical prompt and Board admission even when a client does not list their adapters', async () => {
    const board = createWorkBoardV1({ id: 'workflow', name: 'Work' });
    let opened: ArtifactSharingResourceV1 = { ...resource, header: buildWorkBoardArtifactHeaderV1(board), body: JSON.stringify(board) };
    const owner = createArtifactAccessActionsV1({ read: async () => opened,
      transport: { list: async () => response, set: async () => response, remove: async () => response } });
    await expect(owner({ actionId: 'artifact.access.grants.set', input })).resolves.toEqual(response);
    opened = { ...opened, body: JSON.stringify({ ...board, id: 'other' }) };
    await expect(owner({ actionId: 'artifact.access.grants.set', input })).rejects.toMatchObject({ code: 'artifact_kind_not_shareable' });
    opened = { ...resource, header: { v: 1, kind: 'prompt_doc.v2', title: 'Prompt' },
      body: JSON.stringify({ v: 1, markdown: '# Prompt', createdAtMs: 0, updatedAtMs: 0 }) };
    await expect(owner({ actionId: 'artifact.access.grants.set', input })).resolves.toEqual(response);
    opened = { ...opened, body: '{}' };
    await expect(owner({ actionId: 'artifact.access.grants.set', input })).rejects.toMatchObject({ code: 'artifact_kind_not_shareable' });
    opened = { ...resource, header: { v: 1, kind: 'prompt_bundle.v2', title: 'Bundle', bundleSchemaId: 'bundle.generic_v1' },
      body: JSON.stringify({ v: 1, entries: [{ path: 'notes.txt', contentBase64: 'bm90ZXM=', contentKind: 'utf8' }], createdAtMs: 0, updatedAtMs: 0 }) };
    await expect(owner({ actionId: 'artifact.access.grants.set', input })).resolves.toEqual(response);
    opened = { ...opened, header: { ...opened.header, bundleSchemaId: 'skills.skill_md_v1' } };
    await expect(owner({ actionId: 'artifact.access.grants.set', input })).rejects.toMatchObject({ code: 'artifact_kind_not_shareable' });
    opened = { ...opened, body: JSON.stringify({ v: 1, entries: [{ path: 'SKILL.md', contentBase64: 'IyBTa2lsbA==', contentKind: 'utf8' }], createdAtMs: 0, updatedAtMs: 0 }) };
    await expect(owner({ actionId: 'artifact.access.grants.set', input })).resolves.toEqual(response);
  });
});
