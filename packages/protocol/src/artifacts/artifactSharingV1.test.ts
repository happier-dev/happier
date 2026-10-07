import { describe, expect, it } from 'vitest';
import { prepareArtifactHeaderForRevisionV1 } from './artifactHeaderRestorationV1.js';

import {
  filterArtifactSharingResourcesByKindV1,
  workflowDefinitionArtifactSharingAdapterV1,
  getArtifactUseTargetV1,
  artifactKindRequiresTextBodyV1,
} from './artifactSharingV1.js';

const artifact = {
  artifactId: 'definition-1', ownerAccountId: 'owner', access: 'owner' as const,
  header: {
    kind: 'workflow-definition.v1', definitionId: 'definition-1',
    revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Review' },
  },
};
describe('Document sharing kind owner', () => {
  it('keeps internal layouts and approvals out of the browser and public links while ordinary documents remain shareable', () => {
    const target = (kind?: string) => getArtifactUseTargetV1({ artifactId: 'doc', header: kind ? { kind } : {} });
    expect(target('widget-area-layout.v1')).toMatchObject({ browserListed: false, publicLinkAllowed: false, canShare: true });
    expect(target('home-hub-layout.v1')).toMatchObject({ browserListed: false, publicLinkAllowed: false, canShare: false });
    for (const kind of ['approval_request.v1', 'target_action_approval.v1', 'execution_run_host_action_approval.v1']) {
      expect(target(kind)).toMatchObject({ browserListed: false, publicLinkAllowed: false, canShare: false });
    }
    for (const kind of [undefined, 'text', 'published.v1']) {
      expect(target(kind)).toMatchObject({ kind: 'open', browserListed: true, publicLinkAllowed: true, canShare: true });
    }
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
