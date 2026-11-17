import { describe, expect, it } from 'vitest';
import { getActionSpec } from '../actionSpecs.js';
import { readActionApprovalScopeAdmissionV1 } from './approvalScope.js';

describe('declared Action operands', () => {
  it('projects the exact qualified Project without interpreting incidental ids', async () => {
    const spec = getActionSpec('projects.visibility.set');
    const result = await readActionApprovalScopeAdmissionV1({
      actionId: spec.id, spec,
      input: { target: { serverId: 'home', projectKey: 'project' }, expectedRevision: 'absent', hidden: true },
      context: { surface: 'cli', serverId: 'home', defaultSessionId: 'unrelated-session' },
      deps: {}, phase: 'prepare', isSameHome: (left, right) => left === right,
    });
    expect(result).toEqual({ automationSubjects: [{ role: 'operand', subject: {
      kind: 'project', serverId: 'home', projectKey: 'project',
    } }] });
  });

  it('uses the App source declared by deployment defaults', async () => {
    const spec = getActionSpec('projects.deploymentDefaults.set');
    const result = await readActionApprovalScopeAdmissionV1({
      actionId: spec.id, spec,
      input: { serverId: 'home', projectSourceId: 'source', expectedSourceRevision: 1,
        expectedRevision: 0, content: null },
      context: { surface: 'cli', serverId: 'home' }, deps: {}, phase: 'prepare',
      isSameHome: (left, right) => left === right,
    });
    expect(result).toEqual({ automationSubjects: [{ role: 'operand', subject: {
      kind: 'app', serverId: 'home', projectSourceId: 'source',
    } }] });
  });

  it('retains Environment policy while projecting the Environment backup stream', () => {
    const spec = getActionSpec('deployments.backups.run');
    const input = spec.inputSchema.parse({ serverId: 'home', environmentId: 'environment', machineId: 'machine',
      installationId: 'installation', targetLinkId: 'target', deploymentId: 'deployment',
      expectedRevision: 1, configRevision: 1 });
    const project = typeof spec.approvalScope === 'object' ? spec.approvalScope.project : undefined;
    if (!project) throw new Error('Backup operand declaration missing');
    expect(project(input, { serverId: 'home' })).toEqual({ scope: 'environment',
      subjects: [{ kind: 'backup', serverId: 'home', environmentId: 'environment' }] });
  });

  it('projects only the database selected by restore while retaining Environment policy', () => {
    const spec = getActionSpec('deployments.backups.restore');
    const input = spec.inputSchema.parse({ mode: 'confirm', serverId: 'home', environmentId: 'environment',
      machineId: 'machine', installationId: 'installation', targetLinkId: 'target', deploymentId: 'deployment',
      expectedRevision: 1, source: { kind: 'repository', snapshotId: 'snapshot' }, prepareOperationId: 'prepare',
      destination: { kind: 'database', service: 'postgres', database: 'app' } });
    const project = typeof spec.approvalScope === 'object' ? spec.approvalScope.project : undefined;
    if (!project) throw new Error('Database operand declaration missing');
    expect(project(input, { serverId: 'home' })).toEqual({ scope: 'environment', subjects: [
      { kind: 'backup', serverId: 'home', environmentId: 'environment' },
      { kind: 'database', serverId: 'home', target: { kind: 'environment',
        environmentId: 'environment', service: 'postgres', database: 'app' } },
    ] });
    expect(project({ ...input, destination: { kind: 'volume', service: 'postgres', volume: 'data' } },
      { serverId: 'home' })).toEqual({ scope: 'environment', subjects: [
      { kind: 'backup', serverId: 'home', environmentId: 'environment' },
    ] });
  });
});
