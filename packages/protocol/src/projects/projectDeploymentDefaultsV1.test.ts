import { describe, expect, it } from 'vitest';
import { ProjectAccountOrganizationV1Schema } from './projectAccountRowsV1.js';
import { ProjectSourceV1Schema } from './sources/projectSourceV1.js';
import { ProjectDeploymentDefaultsV1Schema, ProjectDeploymentDefaultsPayloadV1Schema } from './projectDeploymentDefaultsV1.js';

describe('shared Project deployment defaults leaf', () => {
  it('keys one strict private leaf by the existing Source identity, outside Source content and Account organization', () => {
    const payload = ProjectDeploymentDefaultsPayloadV1Schema.parse({ projectSourceId: 'source',
      deploymentDefaults: { retainPreviousDeployments: 0, buildMachineId: 'builder' } });
    expect(ProjectDeploymentDefaultsV1Schema.parse({ v: 1, projectSourceId: 'source', revision: 1,
      content: { t: 'plain', v: payload } }).content).toEqual({ t: 'plain', v: payload });
    expect(ProjectDeploymentDefaultsV1Schema.safeParse({ v: 1, projectSourceId: 'source', revision: 1,
      content: { t: 'plain', v: { ...payload, projectSourceId: 'foreign' } } }).success).toBe(false);
    expect(ProjectDeploymentDefaultsV1Schema.safeParse({ v: 1, projectSourceId: 'source', revision: 1,
      content: { t: 'encrypted', c: 'ciphertext' }, owner: { kind: 'account', accountId: 'copied' } }).success).toBe(false);
    expect(ProjectAccountOrganizationV1Schema.safeParse({ deploymentDefaults: payload.deploymentDefaults }).success).toBe(false);
    expect(ProjectSourceV1Schema.safeParse({ id: 'source', revision: 1, name: 'Project', audience: [],
      createdByAccountId: 'owner', deploymentDefaults: payload.deploymentDefaults }).success).toBe(false);
  });
});
