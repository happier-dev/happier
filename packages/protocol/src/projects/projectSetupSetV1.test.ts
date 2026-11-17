import { describe, expect, it } from 'vitest';
import { readProjectSetupSetChildRpcEffectV1 } from '../actions/projectActionIdsV1.js';
import { PROJECT_DEFINITION_ACTION_RPC_METHODS_V1 } from '../actions/projectDefinitionActionIdsV1.js';
import { isProjectSetupSetChildInputV1, type ProjectSetupSetInputV1 } from './projectSetupSetV1.js';

describe('Project setup child purposes', () => {
  const workspace = { serverId: 'home', machineId: 'machine', workspaceId: 'checkout', rootPath: '/repo' };
  const root: ProjectSetupSetInputV1 = { projectRef: { serverId: 'home', projectKey: 'project' }, workspace,
    expectedRevision: 'absent', intent: { kind: 'accept', sourceId: 'selected-source' } };
  it('admits only repository inspection as a setup decision RPC child', () => {
    expect(readProjectSetupSetChildRpcEffectV1('projects.setup.set', PROJECT_DEFINITION_ACTION_RPC_METHODS_V1['projects.inspect'])).toBe('projects.inspect');
    expect(readProjectSetupSetChildRpcEffectV1('projects.setup.set', PROJECT_DEFINITION_ACTION_RPC_METHODS_V1['projects.manifest.update'])).toBeNull();
    expect(readProjectSetupSetChildRpcEffectV1('projects.inspect', PROJECT_DEFINITION_ACTION_RPC_METHODS_V1['projects.inspect'])).toBeNull();
  });
  it('binds publication and repository reads to the exact setup decision', () => {
    expect(isProjectSetupSetChildInputV1(root, 'projects.sources.read', { serverId: 'home', sourceId: 'selected-source' })).toBe(true);
    expect(isProjectSetupSetChildInputV1(root, 'projects.sources.read', { serverId: 'home', sourceId: 'other' })).toBe(false);
    expect(isProjectSetupSetChildInputV1(root, 'projects.sources.read', { serverId: 'canonical-home', sourceId: 'selected-source' }, 'canonical-home')).toBe(true);
    expect(isProjectSetupSetChildInputV1(root, 'artifact.get', { artifactId: 'publication', projectSourceId: 'selected-source' })).toBe(true);
    expect(isProjectSetupSetChildInputV1(root, 'artifact.get', { artifactId: 'publication', projectSourceId: 'other' })).toBe(false);
    expect(isProjectSetupSetChildInputV1(root, 'projects.inspect', { workspace, read: { kind: 'editor' } })).toBe(true);
    expect(isProjectSetupSetChildInputV1(root, 'projects.inspect', { workspace: { ...workspace, rootPath: '/other' }, read: { kind: 'editor' } })).toBe(false);
    expect(isProjectSetupSetChildInputV1(root, 'projects.inspect', { workspace, read: { kind: 'execution' } })).toBe(false);
  });
  it('permits only a protected accepted detail creation and retains ordinary Artifact access checks', () => {
    expect(isProjectSetupSetChildInputV1(root, 'artifact.get', { artifactId: 'own-accepted-detail' })).toBe(true);
    expect(isProjectSetupSetChildInputV1(root, 'artifact.create', { header: { kind: 'project_setup.v1' },
      body: JSON.stringify({ kind: 'project_setup.v1', setupOverrides: { version: 1 } }) })).toBe(true);
    expect(isProjectSetupSetChildInputV1(root, 'artifact.create', { header: { kind: 'doc' }, body: 'unrelated' })).toBe(false);
    expect(isProjectSetupSetChildInputV1(root, 'artifact.update', { artifactId: 'incumbent' })).toBe(false);
    expect(isProjectSetupSetChildInputV1({ ...root, intent: { kind: 'detach' } }, 'projects.sources.read',
      { serverId: 'home', sourceId: 'selected-source' })).toBe(false);
  });
});
