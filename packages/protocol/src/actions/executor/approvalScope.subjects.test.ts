import { describe, expect, it } from 'vitest';
import { getActionSpec } from '../actionSpecs.js';
import { readActionApprovalScopeAdmissionV1 } from './approvalScope.js';
import { createActionAutomationPortV1 } from './actionAutomationAdmission.js';
import { automationSubjectKeyV1, projectAutomationDatabaseFindingSubjectV1 } from '../../automations/automationSubjectV1.js';

describe('declared Action operands', () => {
  it.each([
    { actionId: 'projects.sources.update', input: { patch: { name: 'QA-C resumed resource App' } } },
    { actionId: 'projects.sources.delete', input: {} },
    { actionId: 'projects.sources.moveToTeam', input: { teamId: 'team', requestKey: 'move-source' } },
  ] as const)('matches exact App and any App checks with a client selector for $actionId', async ({ actionId, input }) => {
    const subject = { kind: 'app' as const, serverId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN',
      projectSourceId: 'cmwl4o0x2000kpnm2cardo97i' };
    const spec = getActionSpec(actionId);
    const context = { surface: 'cli' as const, serverId: subject.serverId, defaultSessionMachineId: 'machine' };
    const port = createActionAutomationPortV1({ accountId: 'actor', seed: async () => ({ v: 1, rows: [
      { automationId: 'checks', triggerId: 'exact', triggerRevision: 0, workflowId: 'workflow', workflowRevision: 1,
        ownerAccountId: 'actor', actionIds: [actionId], phase: 'after', subjectKind: 'app', subjectKey: automationSubjectKeyV1(subject) },
      { automationId: 'checks', triggerId: 'any', triggerRevision: 0, workflowId: 'workflow', workflowRevision: 1,
        ownerAccountId: 'actor', actionIds: [actionId], phase: 'after' },
    ] }), settle: async () => {} });
    const select = async (sourceId: string) => {
      const request = { serverId: subject.serverId, sourceId, expectedRevision: 1, clientId: 'answering-client', ...input };
      const admission = await readActionApprovalScopeAdmissionV1({ actionId, spec, input: request, context,
        deps: {}, phase: 'prepare', isSameHome: (left, right) => left === right });
      if ('ok' in admission) throw new Error(admission.errorCode);
      return port.select({ actionId, input: request, context, subjects: admission.automationSubjects });
    };
    expect((await select(subject.projectSourceId)).after.map(row => row.triggerId)).toEqual(['exact', 'any']);
    expect((await select('another-source')).after.map(row => row.triggerId)).toEqual(['any']);
  });

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
    const database = 'private-restore-destination-name';
    const input = spec.inputSchema.parse({ mode: 'confirm', serverId: 'home', environmentId: 'environment',
      machineId: 'machine', installationId: 'installation', targetLinkId: 'target', deploymentId: 'deployment',
      expectedRevision: 1, source: { kind: 'repository', snapshotId: 'snapshot' }, prepareOperationId: 'prepare',
      destination: { kind: 'database', service: 'postgres', database } });
    const project = typeof spec.approvalScope === 'object' ? spec.approvalScope.project : undefined;
    if (!project) throw new Error('Database operand declaration missing');
    const scope = project(input, { serverId: 'home' });
    expect(JSON.stringify(scope)).not.toContain(database);
    expect(scope).toEqual({ scope: 'environment', subjects: [
      { kind: 'backup', serverId: 'home', environmentId: 'environment' },
      projectAutomationDatabaseFindingSubjectV1('home', { kind: 'environment_binding',
        environmentId: 'environment', address: { service: 'postgres' } }),
    ] });
    expect(project({ ...input, destination: { kind: 'volume', service: 'postgres', volume: 'data' } },
      { serverId: 'home' })).toEqual({ scope: 'environment', subjects: [
      { kind: 'backup', serverId: 'home', environmentId: 'environment' },
    ] });
  });
});
