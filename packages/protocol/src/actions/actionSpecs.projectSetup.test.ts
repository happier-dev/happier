import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { ActionSpecSchema, getActionSpec } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from './projectActionFamily.js';

describe('Project preparation Action contracts', () => {
  it('accepts actual finite completion declarations at the canonical catalog validator', () => {
    for (const id of ['projects.prepare', 'projects.script.run', 'projects.compute.exec'] as const) {
      expect(ActionSpecSchema.safeParse(getActionSpec(id)).success).toBe(true);
    }
  });
  it('requires the reviewed Trust row basis before revocation', () => {
    const project = { serverId: 'home', projectId: 'project' };
    expect(PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.trust.revoke'].safeParse({ project }).success).toBe(false);
    expect(PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.trust.revoke'].safeParse({ project, expectedRevision: 1, expectedEffectDigest: 'reviewed' }).success).toBe(true);
  });
  it('uses an exact admitted Workspace address, not caller-owned persisted row fields', () => {
    const workspace = { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/repo' };
    expect(PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.prepare'].safeParse({ workspace, phase: 'setup' }).success).toBe(true);
    expect(PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.prepare'].safeParse({ workspace: { ...workspace, projectKey: 'forged' }, phase: 'setup' }).success).toBe(false);
  });
  it('registers trust reads and configurable dangerous preparation without a trust-grant Action', () => {
    const ids = ['projects.trust.list', 'projects.trust.revoke', 'projects.prepare', 'projects.script.run', 'projects.compute.exec'] as const;
    for (const id of ids) expect(ActionIdSchema.safeParse(id).success).toBe(true);
    expect(ActionIdSchema.safeParse('projects.trust.grant').success).toBe(false);
    for (const id of ids) {
      const spec = getActionSpec(id as Parameters<typeof getActionSpec>[0]);
      expect(spec.inputSchema.safeParse({ unexpected: true }).success).toBe(false);
      expect(resolveActionApprovalRouting({ actionId: spec.id, spec,
        context: { surface: 'agent' } }).required).toBe(id !== 'projects.trust.list');
      expect(resolveActionApprovalRouting({ actionId: spec.id, spec,
        context: { surface: 'agent' }, settings: ActionsSettingsV1Schema.parse({ v: 1,
          approvalWaivedSurfaces: { [id]: ['agent'] },
        }) }).required).toBe(false);
    }
  });
});
