import { describe, expect, it } from 'vitest';
import { prepareArtifactHeaderForBodyV1, prepareArtifactHeaderForRevisionV1 } from './artifactHeaderRestorationV1.js';
import { buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1 } from '../widgets/widgetSurfaceArtifactV1.js';
import { buildWorkBoardArtifactHeaderV1 } from '../boards/workBoardArtifactV1.js';
import { createWorkBoardV1 } from '../boards/workBoardV1.js';
import { WidgetInstanceV1Schema } from '../widgets/widgetInstanceV1.js';
import { ArtifactDocumentV1Schema, projectArtifactHeaderV1 } from './artifactActionsV1.js';

import {
  filterArtifactSharingResourcesByKindV1,
  workflowDefinitionArtifactSharingAdapterV1,
  getArtifactUseTargetV1,
  artifactKindRequiresTextBodyV1,
  readArtifactSharedAudienceV1,
} from './artifactSharingV1.js';

const artifact = {
  artifactId: 'definition-1', ownerAccountId: 'owner', access: 'owner' as const,
  header: {
    kind: 'workflow-definition.v1', definitionId: 'definition-1',
    revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Review' },
  },
};
describe('Document sharing kind owner', () => {
  it('normalizes absent and future authenticated audience facts without inferring privacy or leaking native body fields', () => {
    const native = { artifactId: 'board', ownerAccountId: 'owner', access: 'owner', header: { kind: 'work-board.v1' },
      headerVersion: 1, bodyVersion: 2, seq: 1, createdAt: 1, updatedAt: 1 };
    for (const [wire, expected] of [[undefined, 'unknown'], ['future-audience', 'unknown'], [null, 'unknown'],
      ['retained', 'retained'], ['none', 'none']] as const) {
      const projected = projectArtifactHeaderV1({ ...native, publicAudience: wire });
      expect(projected).toMatchObject({ publicAudience: expected });
      expect(projected).not.toHaveProperty('bodyVersion');
      const { headerVersion: _, ...header } = projected;
      expect(ArtifactDocumentV1Schema.parse({ ...header, body: '{}', revision: { headerVersion: 1, bodyVersion: 2 } }))
        .toMatchObject({ publicAudience: expected });
    }
  });
  it('admits retained public audience with public sharing disabled', async () => {
    const current = { artifactId: 'board', ownerAccountId: 'owner', access: 'owner' as const,
      publicAudience: 'retained' as const, header: { kind: 'work-board.v1' } };
    await expect(readArtifactSharedAudienceV1({ current,
      readGrants: async () => ({ artifactId: 'board', ownerAccountId: 'owner', access: 'owner', grants: [] }) })).resolves.toBe(true);
  });
  it('includes retained public publications in the actual Artifact audience until expiry or deletion, not use exhaustion', async () => {
    const current = { artifactId: 'board', ownerAccountId: 'owner', access: 'owner' as const,
      publicAudience: 'retained' as 'retained' | 'none' | 'unknown' | undefined, header: { kind: 'work-board.v1' } };
    const grants = { artifactId: 'board', ownerAccountId: 'owner', access: 'owner' as const, grants: [] };
    const read = () => readArtifactSharedAudienceV1({ current, readGrants: async () => grants });
    expect(await read()).toBe(true);
    // Expiry/deletion belong to the server publication owner; its exact read emits none.
    current.publicAudience = 'none';
    expect(await read()).toBe(false);
    for (const publicAudience of [undefined, 'unknown'] as const) {
      current.publicAudience = publicAudience;
      await expect(read()).rejects.toMatchObject({ code: 'content_unavailable' });
      await expect(readArtifactSharedAudienceV1({ current: { ...current, access: 'view' }, readGrants: async () => grants })).resolves.toBe(true);
    }
    current.publicAudience = 'none';
    await expect(readArtifactSharedAudienceV1({ current, readGrants: async () => ({ ...grants, artifactId: 'other' }) }))
      .rejects.toMatchObject({ code: 'content_unavailable' });
    await expect(readArtifactSharedAudienceV1({ current, readGrants: async () => { throw Object.assign(new Error('unavailable'), { code: 'artifact_access_unavailable' }); } }))
      .rejects.toMatchObject({ code: 'artifact_access_unavailable' });
  });
  it('admits memory documents through the document kind owner and refuses malformed facts', () => {
    const resource = { artifactId: 'memory', header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' },
      body: JSON.stringify({ v: 1, facts: [], archive: [] }) };
    expect(artifactKindRequiresTextBodyV1('memory_doc.v1')).toBe(true);
    expect(getArtifactUseTargetV1(resource)).toMatchObject({ kind: 'memory', canShare: true, publicLinkAllowed: true, browserListed: true });
    expect(getArtifactUseTargetV1({ ...resource, body: JSON.stringify({ v: 1, facts: [{ text: 'no identity' }], archive: [] }) })).toMatchObject({ canShare: false, publicLinkAllowed: false });
  });
  it('keeps internal layouts and approvals out of the browser and public links while ordinary documents remain shareable', () => {
    const target = (kind?: string) => getArtifactUseTargetV1({ artifactId: 'doc', header: kind ? { kind } : {} });
    expect(target('widget-area-layout.v1')).toMatchObject({ browserListed: false, publicLinkAllowed: false, canShare: false });
    expect(target('home-hub-layout.v1')).toMatchObject({ browserListed: false, publicLinkAllowed: false, canShare: false });
    expect(target('usage_notice.v1')).toMatchObject({ browserListed: false, publicLinkAllowed: false, canShare: false });
    expect(artifactKindRequiresTextBodyV1('usage_notice.v1')).toBe(true);
    for (const kind of ['approval_request.v1', 'target_action_approval.v1', 'execution_run_host_action_approval.v1']) {
      expect(target(kind)).toMatchObject({ browserListed: false, publicLinkAllowed: false, canShare: false });
    }
    for (const kind of [undefined, 'text', 'published.v1']) {
      expect(target(kind)).toMatchObject({ kind: 'open', browserListed: true, publicLinkAllowed: true, canShare: true });
    }
  });
  it('validates stored dashboard content and private inputs while retaining private-definition placeholders', () => {
    const surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'project', projectId: 'project' } } as const;
    const instance = { v: 1, id: 'private-placeholder', definition: { kind: 'artifact', artifactId: 'private-definition' }, bindings: {} } as const;
    const layout = { v: 1 as const, surface, items: [{ kind: 'widget' as const, instance, area: 'main' as const }] };
    const resource = { artifactId: buildWidgetSurfaceArtifactIdV1(surface),
      header: buildWidgetSurfaceArtifactHeaderV1(layout), body: JSON.stringify(layout) };
    expect(getArtifactUseTargetV1(resource)).toMatchObject({ canShare: true, browserListed: false, publicLinkAllowed: false });
    expect(getArtifactUseTargetV1({ ...resource, body: JSON.stringify({ ...layout, extra: true,
      items: [{ kind: 'widget', instance: { ...instance, extra: true }, extra: true }] }) }).canShare).toBe(true);
    for (const body of ['{bad', JSON.stringify({ ...layout, surface: { ...surface, accountId: 'wrong' } }),
      JSON.stringify({ ...layout, items: [{ kind: 'widget', instance: { ...instance, extra: {
        service: { pluginId: 'com.acme.test', localId: 'cloud' }, accountId: 'private',
      } } }] }),
      JSON.stringify({ ...layout, items: [{ kind: 'widget', instance: { ...instance, bindings: { cloud: { kind: 'value', value: { nested: [{
        service: { pluginId: 'com.acme.test', localId: 'cloud', extra: true }, accountId: 'private', extra: true,
      }] } } } } }] })]) {
      expect(getArtifactUseTargetV1({ ...resource, body }).canShare).toBe(false);
    }
  });
  it('refuses WorkBoard sharing for nested author pins without banning private definition references', () => {
    const surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'workBoard', boardId: 'board' } } as const;
    const instance = { v: 1, id: 'copy', definition: { kind: 'artifact', artifactId: 'private-definition' }, bindings: {} } as const;
    const board = { ...createWorkBoardV1({ id: 'board', name: 'Board' }), widgets: [{ kind: 'widget' as const, ref: { surface, instanceId: instance.id }, instance, size: 'medium' as const }] };
    const resource = { artifactId: board.id, header: buildWorkBoardArtifactHeaderV1(board), body: JSON.stringify(board) };
    expect(getArtifactUseTargetV1(resource).canShare).toBe(true);
    const pinned = { ...board, widgets: [{ ...board.widgets[0], instance: { ...instance, bindings: { cloud: { kind: 'value', value: {
      nested: [{ service: { pluginId: 'com.acme.test', localId: 'cloud' }, accountId: 'private' }],
    } } } } }] };
    expect(getArtifactUseTargetV1({ ...resource, body: JSON.stringify(pinned) }).canShare).toBe(false);
  });
  it('admits shared WorkBoard writes and restores through the existing kind content owner, including retag attempts', () => {
    const surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'workBoard', boardId: 'board' } } as const;
    const instance = { v: 1, id: 'copy', definition: { kind: 'artifact', artifactId: 'private-definition' }, bindings: {} } as const;
    const board = { ...createWorkBoardV1({ id: 'board', name: 'Board' }), widgets: [{ kind: 'widget' as const,
      ref: { surface, instanceId: instance.id }, instance, size: 'medium' as const }] };
    const current = { artifactId: board.id, header: buildWorkBoardArtifactHeaderV1(board), body: JSON.stringify(board) };
    const pinned = { ...board, widgets: [{ ...board.widgets[0], instance: { ...instance, bindings: { cloud: { kind: 'value', value: {
      nested: [{ service: { pluginId: 'com.acme.test', localId: 'cloud' }, accountId: 'private' }],
    } } } } }] };
    const body = JSON.stringify(pinned);
    for (const header of [current.header, { kind: 'ordinary' }]) {
      expect(() => prepareArtifactHeaderForBodyV1(header, body, { current, shared: true }))
        .toThrow(expect.objectContaining({ code: 'artifact_shared_content_forbidden' }));
    }
    expect(() => prepareArtifactHeaderForRevisionV1({ artifactId: board.id, header: current.header, body, shared: true,
      expectedRevision: { headerVersion: 1, bodyVersion: 1 }, nextRevision: { headerVersion: 2, bodyVersion: 2 } }))
      .toThrow(expect.objectContaining({ code: 'artifact_shared_content_forbidden' }));
    expect(prepareArtifactHeaderForBodyV1(current.header, current.body, { current, shared: true })).toMatchObject({ kind: 'work-board.v1' });
    expect(prepareArtifactHeaderForBodyV1(current.header, body, { current, shared: false })).toMatchObject({ kind: 'work-board.v1' });
  });
  it('requires inline live Resource reads to resolve viewer inputs rather than authored literals', () => {
    const surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'project', projectId: 'project' } } as const;
    const data = { kind: 'resource', resource: { pluginId: 'com.acme.test', localId: 'metrics' },
      inputSchema: { type: 'object', additionalProperties: false }, input: {},
      outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false } };
    const definition = { v: 1, id: 'metric', name: 'Metric', sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
      body: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Count', data, value: { path: ['count'], type: 'number' } } } } };
    const instance = WidgetInstanceV1Schema.parse({ v: 1, id: 'metric', definition: { kind: 'inline', definition }, bindings: {} });
    const layout = { v: 1 as const, surface, items: [{ kind: 'widget' as const, instance, area: 'main' as const }] };
    const resource = { artifactId: buildWidgetSurfaceArtifactIdV1(surface), header: buildWidgetSurfaceArtifactHeaderV1(layout),
      body: JSON.stringify(layout) };
    expect(getArtifactUseTargetV1(resource).canShare).toBe(false);
    const { input: _literal, ...viewerData } = data;
    const safe = { ...instance, definition: { kind: 'inline', definition: { ...definition, body: { kind: 'declarative', document: { version: 1,
      root: { ...definition.body.document.root, data: viewerData } } } } } };
    expect(getArtifactUseTargetV1({ ...resource, body: JSON.stringify({ v: 1, surface, items: [{ kind: 'widget', instance: safe }] }) }).canShare).toBe(true);
  });
  it('restores unknown stored Workflow body fields through the canonical header projection', () => {
    const header = { kind: 'workflow-definition.v1', definitionId: 'definition-1',
      revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Review' }, savedBy: { kind: 'person' } };
    const body = JSON.stringify({ kind: 'workflow-definition.v1', extra: true, definition: {
      version: 1, extra: true, defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      blocks: [{ kind: 'step', id: 'review', extra: true, document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
    } });
    const restored = prepareArtifactHeaderForRevisionV1({ artifactId: 'definition-1', header, body,
      expectedRevision: header.revision, nextRevision: { headerVersion: 2, bodyVersion: 2 } });
    expect(restored).toMatchObject({ kind: 'workflow-definition.v1', definitionId: 'definition-1', revision: { headerVersion: 2, bodyVersion: 2 },
      metadata: { title: 'Review' }, previewSteps: ['Review'] });
    expect(restored).not.toHaveProperty('savedBy');
  });
  it('routes ordinary documents and specialized text kinds through their canonical policies', () => {
    expect(getArtifactUseTargetV1({ artifactId: 'doc', header: {} }).kind).toBe('open');
    expect(getArtifactUseTargetV1({ artifactId: 'doc', header: { kind: 'prompt_doc.v2' } }).kind).toBe('prompt_doc');
    expect(getArtifactUseTargetV1({ artifactId: 'bundle', header: { kind: 'prompt_bundle.v2' } }).kind).toBe('prompt_bundle');
    expect(artifactKindRequiresTextBodyV1('approval_request.v1')).toBe(true);
    expect(artifactKindRequiresTextBodyV1('target_action_approval.v1')).toBe(true);
    expect(artifactKindRequiresTextBodyV1('execution_run_host_action_approval.v1')).toBe(true);
    expect(artifactKindRequiresTextBodyV1('published.v1')).toBe(false);
  });
  it('filters only supplied grant-reachable opened headers by their validated kind', () => {
    const resources = [artifact, { ...artifact, artifactId: 'role-1', header: { kind: 'role.v1' } },
      { ...artifact, header: { ...artifact.header, definitionId: 'other' } },
      { ...artifact, revision: { headerVersion: 2, bodyVersion: 1 } }];
    expect(filterArtifactSharingResourcesByKindV1(resources, workflowDefinitionArtifactSharingAdapterV1)).toEqual([artifact]);
  });
});
