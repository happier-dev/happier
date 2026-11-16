import { describe, expect, it } from 'vitest';
import { DeploymentPrepareInputV1Schema, deriveDeploymentPrepareSessionSpawnInputV1, buildDeploymentPreparationBriefV1 } from './deploymentPreparationV1.js';
import { SessionSpawnNewActionInputV2Schema } from '../sessions/creation/sessionSpawnNewInputV2.js';
import { DEPLOYMENT_VALIDATION_RULES_V1 } from './deploymentValidationV1.js';

const source = {
  projectSourceId: 'source', sourceRevision: 1,
  repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
  baseCommit: 'a'.repeat(40),
  workspace: { kind: 'workspace-ref', serverId: 'home', id: 'workspace' },
};

describe('Prepare reviewed Session and import references', () => {
  it('preserves the complete reviewed Session recipe in the public child vocabulary', () => {
    const input = DeploymentPrepareInputV1Schema.parse({ ...source, sessionDraft: {
      executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/repo' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      organizationPlacement: { folderId: 'folder', tagIds: ['tag'] },
      title: 'Reviewed recipe', memoryEnabled: false, transcriptStorage: 'direct',
      modelSelection: { v: 1, ref: { agentTargetKey: 'codex', providerConnectionId: null, modelId: 'reviewed-model' }, updatedAt: 0 },
    } });
    const child = deriveDeploymentPrepareSessionSpawnInputV1(input);
    expect(buildDeploymentPreparationBriefV1(input).split(DEPLOYMENT_VALIDATION_RULES_V1)).toHaveLength(2);
    expect(SessionSpawnNewActionInputV2Schema.parse(child)).toEqual({ ...input.sessionDraft,
      organizationPlacement: { sectionId: 'folder', tagIds: ['tag'] },
      initialInput: { text: buildDeploymentPreparationBriefV1(input) } });
    expect(deriveDeploymentPrepareSessionSpawnInputV1(DeploymentPrepareInputV1Schema.parse({ ...source,
      sessionRef: { serverId: 'home', sessionId: 'existing-session' } }))).toBeNull();
  });

  it('retains an exact existing Session and reference-only import intent through public input parsing', () => {
    const input = { ...source, sessionRef: { serverId: 'home', sessionId: 'existing-session' },
      importFrom: { tool: 'Previous manager', configurationPaths: ['app.json', 'deploy/compose.yaml'] } };
    expect(DeploymentPrepareInputV1Schema.parse(input)).toEqual(input);
    expect(DeploymentPrepareInputV1Schema.safeParse(source).success).toBe(false);
    expect(DeploymentPrepareInputV1Schema.safeParse({ ...input, sessionDraft: {
      executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/repo' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    } }).success).toBe(false);
  });

  it('rejects inline imported material and credentials instead of silently dropping them', () => {
    const input = { ...source, sessionRef: { serverId: 'home', sessionId: 'existing-session' },
      importFrom: { tool: 'Previous manager', configurationPaths: ['app.json'],
      configuration: { password: 'not-session-input' } } };
    expect(DeploymentPrepareInputV1Schema.safeParse(input).success).toBe(false);
  });
});
