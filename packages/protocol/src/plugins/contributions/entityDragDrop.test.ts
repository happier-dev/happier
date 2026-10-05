import { describe, expect, it } from 'vitest';
import { PluginContributesV2Schema } from './v2.js';
import { derivePluginClientContributionRegistrationRights, derivePluginDaemonContributionRegistrationRights, PLUGIN_CONTRIBUTION_CATALOG_V2 } from './catalog.js';
import { isPluginDropTargetActionAllowedV1, validatePluginDragSourceReferenceV1 } from './entityDragDrop.js';

const client = { artifactId: 'entity-runtime', exportName: 'activate' };
const source = { id: 'issue', title: 'Issue', referenceSchema: { type: 'object', properties: { issueId: { type: 'string' } }, required: ['issueId'], additionalProperties: false }, client, platforms: ['web'] };
const target = { id: 'review', title: 'Review', acceptedKinds: ['session', 'plugin:com.acme.entities/issue'], actions: [{ kind: 'host', actionId: 'session.open' }, { kind: 'plugin', action: 'review' }], client, platforms: ['web'] };

describe('declared entity drag/drop contributions', () => {
  it('admits an exact local composer attachment selection through the canonical catalog', () => {
    const descriptor = { ...source, composerAttachment: 'entry' };
    expect(PluginContributesV2Schema.safeParse({ dragSources: [descriptor] }).success).toBe(true);
    expect(PLUGIN_CONTRIBUTION_CATALOG_V2.find(entry => entry.manifestKey === 'dragSources')?.extractReferences(descriptor)).toContainEqual({
      targetFamily: 'composerAttachments', reference: 'entry', path: ['composerAttachment'],
    });
    expect(PluginContributesV2Schema.safeParse({ dragSources: [{ ...source, composerAttachment: { pluginId: 'other.plugin', localId: 'entry' } }] }).success).toBe(false);
  });
  it('uses the declared reference schema and exact admitted Action identity', () => {
    const declarations = PluginContributesV2Schema.parse({ dragSources: [source], dropTargets: [target] });
    expect(validatePluginDragSourceReferenceV1(declarations.dragSources[0]!, { issueId: 'one' })).toBe(true);
    expect(validatePluginDragSourceReferenceV1(declarations.dragSources[0]!, { issueId: 'one', machineId: 'foreign' })).toBe(false);
    expect(validatePluginDragSourceReferenceV1(declarations.dragSources[0]!, { issueId: 1 })).toBe(false);
    const declared = declarations.dropTargets[0]!;
    expect(isPluginDropTargetActionAllowedV1(declared, 'com.acme.entities', 'session.open')).toBe(true);
    expect(isPluginDropTargetActionAllowedV1(declared, 'com.acme.entities', 'plugin:com.acme.entities/review')).toBe(true);
    expect(isPluginDropTargetActionAllowedV1(declared, 'com.acme.entities', 'plugin:com.acme.foreign/review')).toBe(false);
    expect(isPluginDropTargetActionAllowedV1(declared, 'com.acme.entities', 'session.stop')).toBe(false);
  });
  it('admits closed portable families and grants only their exact answering client entry', () => {
    const parsed = PluginContributesV2Schema.safeParse({ dragSources: [source], dropTargets: [target] });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(derivePluginDaemonContributionRegistrationRights(parsed.data)).toEqual([]);
    expect(derivePluginClientContributionRegistrationRights(parsed.data, { ...client, platform: 'web' })).toEqual([
      { family: 'dragSources', localId: 'issue', target: { realm: 'client', ...client, platforms: ['web'] } },
      { family: 'dropTargets', localId: 'review', target: { realm: 'client', ...client, platforms: ['web'] } },
    ]);
    expect(derivePluginClientContributionRegistrationRights(parsed.data, { ...client, exportName: 'other', platform: 'web' })).toEqual([]);
    expect(derivePluginClientContributionRegistrationRights(parsed.data, { ...client, platform: 'ios' })).toEqual([]);
  });

  it('rejects malformed identity/kinds, remote schemas and unadmitted host Actions', () => {
    for (const declaration of [{ ...source, id: 'Invalid' }, { ...source, referenceSchema: { $ref: 'https://example.com/schema' } }, { ...source, callback: 'foreign' }]) {
      expect(PluginContributesV2Schema.safeParse({ dragSources: [declaration] }).success).toBe(false);
    }
    for (const declaration of [{ ...target, acceptedKinds: ['plugin:invalid/issue'] }, { ...target, acceptedKinds: ['plugin'] }, { ...target, actions: [{ kind: 'host', actionId: 'session.handoff.commit' }] }, { ...target, actions: [{ kind: 'host', actionId: 'session.canvas.tabs.unknown' }] }]) {
      expect(PluginContributesV2Schema.safeParse({ dropTargets: [declaration] }).success).toBe(false);
    }
    expect(PluginContributesV2Schema.safeParse({ dropTargets: [{ ...target,
      actions: [{ kind: 'host', actionId: 'session.canvas.tabs.open' }],
    }] }).success).toBe(true);
  });

  it('keeps Action and artifact reference admission at the catalog owner', () => {
    const family = PLUGIN_CONTRIBUTION_CATALOG_V2.find(entry => entry.manifestKey === 'dropTargets');
    expect(family?.extractReferences(target)).toEqual([
      { targetFamily: 'generated.uiArtifacts', reference: 'entity-runtime', path: ['client', 'artifactId'] },
      { targetFamily: 'actions', reference: 'review', path: ['actions', 1, 'action'] },
      { targetFamily: 'dragSources', allowQualifiedCrossPlugin: true, allowQualifiedSamePlugin: true, reference: { pluginId: 'com.acme.entities', localId: 'issue' }, path: ['acceptedKinds', 1] },
    ]);
  });
});
