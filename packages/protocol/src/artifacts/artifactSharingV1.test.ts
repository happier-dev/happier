import { DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
  DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from './deploymentArtifactKindsV1.js';
import { describe, expect, it } from 'vitest';
import { prepareArtifactHeaderForBodyV1, prepareArtifactHeaderForRevisionV1 } from './artifactHeaderRestorationV1.js';
import { buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1 } from '../widgets/widgetSurfaceArtifactV1.js';
import { buildWorkBoardArtifactHeaderV1 } from '../boards/workBoardArtifactV1.js';
import { createWorkBoardV1 } from '../boards/workBoardV1.js';
import { WidgetInstanceV1Schema } from '../widgets/widgetInstanceV1.js';
import { WidgetDefinitionV1Schema } from '../widgets/widgetDefinitionV1.js';
import { ArtifactDocumentV1Schema, projectArtifactHeaderV1 } from './artifactActionsV1.js';
import { ArtifactHtmlBundleV1Schema, ARTIFACT_HTML_BUNDLE_MIME_V1 } from './artifactHtmlV1.js';
import { withArtifactExcerptV1 } from './artifactExcerptV1.js';

import {
  filterArtifactSharingResourcesByKindV1,
  workflowDefinitionArtifactSharingAdapterV1,
  getArtifactUseTargetV1,
  artifactKindRequiresTextBodyV1,
  readArtifactSharedAudienceV1,
  readArtifactPublicNetworkPolicyV1,
} from './artifactSharingV1.js';

const artifact = {
  artifactId: 'definition-1', ownerAccountId: 'owner', access: 'owner' as const,
  header: {
    kind: 'workflow-definition.v1', definitionId: 'definition-1',
    revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Review' },
  },
};
describe('Document sharing kind owner', () => {
  it('keeps deployment intent and native receipts out of ordinary public and people sharing', () => {
    for (const kind of [DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1]) {
      expect(getArtifactUseTargetV1({ artifactId: 'deployment-content', header: { kind }, body: '{}' }))
        .toMatchObject({ browserListed: false, publicLinkAllowed: false, canShare: false });
    }
  });
  it('reports the saved HTML or definition policy and never opens egress from arbitrary header metadata', () => {
    const bundle = ArtifactHtmlBundleV1Schema.parse({ v: 1, entrypoint: 'index.html', requestedCapabilities: { networkOrigins: ['https://assets.example.test'] },
      files: { 'index.html': { mime: 'text/html', contentBase64: 'PGgxPkhlbGxvPC9oMT4=' } } });
    const resource = { artifactId: 'visual', header: { kind: 'html', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 }, body: JSON.stringify(bundle) };
    expect(readArtifactPublicNetworkPolicyV1(resource)).toEqual({ network: 'origins', networkOrigins: ['https://assets.example.test'] });
    expect(readArtifactPublicNetworkPolicyV1({ ...resource, body: null })).toBeNull();
    expect(readArtifactPublicNetworkPolicyV1({ ...resource, body: { blobId: 'd147390f-1ccf-4aa4-b842-7d77fbb057c0',
      mime: ARTIFACT_HTML_BUNDLE_MIME_V1, sizeBytes: 1, sha256: 'a'.repeat(64) } })).toBeNull();
    expect(readArtifactPublicNetworkPolicyV1({ ...resource, body: null, htmlBundle: bundle })).toEqual({ network: 'origins', networkOrigins: ['https://assets.example.test'] });
    expect(readArtifactPublicNetworkPolicyV1({ ...resource, body: '{bad', header: { ...resource.header, requestedCapabilities: { network: 'open' } } }))
      .toEqual({ network: 'none', networkOrigins: [] });
    const definition = { v: 1, id: 'visual', name: 'Saved HTML', sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
      body: { kind: 'html', source: bundle, requestedCapabilities: { network: 'open' } },
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } } };
    const saved = { ...resource, header: { kind: 'widget-definition.v1', v: 1 }, body: JSON.stringify(definition) };
    expect(readArtifactPublicNetworkPolicyV1(saved)).toEqual({ network: 'open', networkOrigins: [] });
    expect(readArtifactPublicNetworkPolicyV1({ ...saved, body: JSON.stringify({ ...definition, networkOverride: { network: 'none' } }) }))
      .toEqual({ network: 'none', networkOrigins: [] });
  });
  it.each(['installed', 'html-resource'] as const)('reports no public egress for an unavailable %s widget despite its stored override', kind => {
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'visual', name: 'Unavailable widget',
      sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, networkOverride: { network: 'open' },
      body: kind === 'installed' ? { kind: 'installed', surface: { pluginId: 'com.acme.widget', localId: 'live' } }
        : { kind: 'html', source: { v: 1, entrypoint: 'index.html', files: {
          'index.html': { mime: 'text/html', contentBase64: 'PGgxPkhlbGxvPC9oMT4=' },
        } }, requestedCapabilities: { network: 'open', resources: [{ pluginId: 'com.acme.widget', localId: 'metrics' }] } },
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } } });
    expect(readArtifactPublicNetworkPolicyV1({ artifactId: 'visual', header: { kind: 'widget-definition.v1', v: 1 }, body: JSON.stringify(definition) }))
      .toEqual({ network: 'none', networkOrigins: [] });
  });
  it('admits validated widget definitions and refuses malformed or substituted saved visuals', () => {
    const definition = { v: 1, id: 'visual', name: 'Saved chart',
      sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
      body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Saved content' } } },
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
      provenance: { source: { kind: 'authored' } } };
    const resource = { artifactId: 'visual', header: { kind: 'widget-definition.v1', v: 1 }, body: JSON.stringify(definition) };
    expect(artifactKindRequiresTextBodyV1('widget-definition.v1')).toBe(true);
    expect(getArtifactUseTargetV1(resource)).toMatchObject({ canShare: true, publicLinkAllowed: true });
    const stored = { ...definition, futureDisplayField: 1,
      provenance: { ...definition.provenance, futureDisplayField: 1 },
      body: { ...definition.body, futureDisplayField: 1, document: { ...definition.body.document,
        root: { ...definition.body.document.root, futureDisplayField: 1 } } } };
    expect(getArtifactUseTargetV1({ ...resource, body: JSON.stringify(stored) }))
      .toMatchObject({ canShare: true, publicLinkAllowed: true });
    const privateSelection = { service: { pluginId: 'com.acme.test', localId: 'cloud', futureDisplayField: 1 }, accountId: 'private' };
    for (const raw of [{ ...stored, futureInput: privateSelection },
      { ...stored, body: { ...stored.body, futureInput: privateSelection } }]) {
      expect(getArtifactUseTargetV1({ ...resource, body: JSON.stringify(raw) }))
        .toMatchObject({ canShare: false, publicLinkAllowed: false });
    }
    expect(WidgetDefinitionV1Schema.safeParse(stored).success).toBe(false);
    for (const body of ['{bad', JSON.stringify({ ...definition, id: 'another' }),
      JSON.stringify({ ...definition, body: { kind: 'declarative', document: {} } })]) {
      expect(getArtifactUseTargetV1({ ...resource, body })).toMatchObject({ canShare: false, publicLinkAllowed: false });
    }
  });
  it('restores the saved widget revision summary from its body instead of the current definition', () => {
    const definition = { v: 1, id: 'visual', name: 'Before',
      sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
      body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Old content' } } },
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
      provenance: { source: { kind: 'authored' } } };
    const header = prepareArtifactHeaderForRevisionV1({ artifactId: 'visual',
      header: { kind: 'widget-definition.v1', v: 1, title: 'Current', summary: { name: 'Current' } },
      body: JSON.stringify({ ...definition, futureDisplayField: 1, provenance: { ...definition.provenance, futureDisplayField: 1 } }),
      shared: true, expectedRevision: { headerVersion: 3, bodyVersion: 3 },
      nextRevision: { headerVersion: 4, bodyVersion: 4 } });
    expect(header).toMatchObject({ title: 'Before', summary: { name: 'Before', bodyKind: 'declarative' } });
  });
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
    expect(target('account_notice.v1')).toMatchObject({ browserListed: false, publicLinkAllowed: false, canShare: false });
    expect(artifactKindRequiresTextBodyV1('account_notice.v1')).toBe(true);
    for (const kind of ['approval_request.v1', 'target_action_approval.v1', 'execution_run_host_action_approval.v1']) {
      expect(target(kind)).toMatchObject({ kind: 'approval', browserListed: false, publicLinkAllowed: false, canShare: false });
    }
    for (const kind of [undefined, 'text', 'published.v1']) {
      expect(target(kind)).toMatchObject({ kind: 'open', browserListed: true, publicLinkAllowed: true, canShare: true });
    }
  });
  it('keeps replay custody out of approval header excerpts on create, update and restore', () => {
    const body = JSON.stringify({ executionOriginV1: { externalActionExecutionAuthorization: { v: 1 } } });
    for (const kind of ['approval_request.v1', 'target_action_approval.v1', 'execution_run_host_action_approval.v1']) {
      const header = { kind, title: 'Review request', excerpt: body };
      const projected = withArtifactExcerptV1(header, body);
      expect(projected).toEqual({ kind, title: 'Review request' });
      expect(header.excerpt).toBe(body);
    }
    expect(withArtifactExcerptV1({ title: 'Document', excerpt: 'old' }, 'Current text'))
      .toEqual({ title: 'Document', excerpt: 'Current text' });
  });
  it('preserves paired private notice identity on writes and restores, not generic workspace provenance', () => {
    const content = { v: 1, source: { kind: 'plugin', pluginId: 'acme.tasks', itemId: 'review' }, type: 'update', resolved: false };
    const header = { ...content, kind: 'account_notice.v1', title: 'Review', status: 'dismissed', readAt: 10 };
    const body = JSON.stringify(content);
    expect(prepareArtifactHeaderForBodyV1(header, body)).toEqual(header);
    const restore = { artifactId: 'notice', header, body, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      nextRevision: { headerVersion: 2, bodyVersion: 2 } };
    expect(prepareArtifactHeaderForRevisionV1(restore)).toEqual(header);
    expect(() => prepareArtifactHeaderForRevisionV1({ ...restore, shared: true })).toThrow();
    expect(() => prepareArtifactHeaderForBodyV1(header, JSON.stringify({ ...content,
      source: { ...content.source, pluginId: 'other.tasks' } }))).toThrow();
    expect(prepareArtifactHeaderForBodyV1({ kind: 'text', source: { machineId: 'workspace' } }, 'Document')).toEqual({ kind: 'text' });
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
    const saved = { artifactId: 'metric', header: { kind: 'widget-definition.v1', v: 1 }, body: JSON.stringify(definition) };
    expect(getArtifactUseTargetV1(saved)).toMatchObject({ canShare: false, publicLinkAllowed: false });
    const { input: _literal, ...viewerData } = data;
    const safe = { ...instance, definition: { kind: 'inline', definition: { ...definition, body: { kind: 'declarative', document: { version: 1,
      root: { ...definition.body.document.root, data: viewerData } } } } } };
    expect(getArtifactUseTargetV1({ ...resource, body: JSON.stringify({ v: 1, surface, items: [{ kind: 'widget', instance: safe }] }) }).canShare).toBe(true);
    expect(getArtifactUseTargetV1({ ...saved, body: JSON.stringify(safe.definition.definition) }))
      .toMatchObject({ canShare: true, publicLinkAllowed: true });
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
