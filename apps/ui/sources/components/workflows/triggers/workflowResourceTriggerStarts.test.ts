import { describe, expect, it } from 'vitest';
import type { ActionDiscoveryDefinitionSummaryV1 } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { serializeActionSpec } from '@happier-dev/protocol/actions/actionCatalog';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { PluginEventAutomationDeclarationV1Schema } from '@happier-dev/protocol/automations/automationEventDeclarationV1';
import { listWorkflowStepActionSpecs } from '../presentation/workflowActionCatalog';
import { buildResourceWorkflowTriggerStartOptions, formatWorkflowLinkStartLabel } from './workflowTriggerStarts';

const subject = { kind: 'environment', serverId: 'home', environmentId: 'production' } as const;
const action = serializeActionSpec(getActionSpec('deployments.deploy'), { includeOutputSchema: false });
const event = (localId: string, subjectKinds: readonly ('environment' | 'machine' | 'project')[]) => ({
  eventRef: { pluginId: 'acme.deploy', localId }, title: localId, pluginName: 'Deploy',
  automation: PluginEventAutomationDeclarationV1Schema.parse({ v: 1, eligible: true, subjectKinds,
    source: { sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull'],
      sourceConfigSchema: { type: 'object' }, setupActionRef: { pluginId: 'acme.deploy', localId: 'setup' } } }),
});

describe('resource Link When choices', () => {
  it('offers the Project’s events and own Actions without promoting Session context into Project Actions', () => {
    const project = { kind: 'project', serverId: 'home', projectKey: 'project-1' } as const;
    const sessionAction = serializeActionSpec(getActionSpec('session.goal.set'), { includeOutputSchema: false });
    const projectAction = serializeActionSpec(getActionSpec('projects.setup.set'), { includeOutputSchema: false });
    const actions = listWorkflowStepActionSpecs(null, null, undefined, [sessionAction, projectAction], 'automation');
    const finished = event('project-setup-finished', ['project', 'machine']);
    const options = buildResourceWorkflowTriggerStartOptions({ subject: project, actions,
      events: [finished, event('machine-ready', ['machine'])], machineId: 'runner' });
    // The resource's own Events lead; Actions on it follow (NF-28).
    expect(options.map(option => option.id)).toEqual([
      'event:acme.deploy/project-setup-finished', 'action:before:projects.setup.set', 'action:after:projects.setup.set',
    ]);
  });
  it('names each restore from the Database resource perspective while preserving the two Action phases', () => {
    const discovery = serializeActionSpec(getActionSpec(DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1), { includeOutputSchema: false });
    const actions = listWorkflowStepActionSpecs(null, null, undefined, [{
      ...discovery, automation: { before: true, after: true, workflowStep: true, subjectKinds: ['database'] },
    }], 'automation');
    const database = { kind: 'database', serverId: 'home', target: { kind: 'environment', environmentId: 'production', service: 'db' } as const } as const;
    const options = buildResourceWorkflowTriggerStartOptions({ subject: database, actions, events: [], machineId: 'runner' });
    expect(options.map(option => [option.relation, formatWorkflowLinkStartLabel(option)])).toEqual([
      ['before', 'Before each restore of this database'], ['after', 'After each restore of this database'],
    ]);
    expect(options.map(option => option.subject)).toEqual([database, database]);
  });
  it('uses admitted phase and subject metadata, with one after row and declared Events requiring source setup', () => {
    const discovery: ActionDiscoveryDefinitionSummaryV1[] = [{ ...action, automation: { before: false, after: true, workflowStep: true,
      subjectKinds: ['environment', 'app'] } }];
    const actions = listWorkflowStepActionSpecs(null, null, undefined, discovery, 'automation');
    const options = buildResourceWorkflowTriggerStartOptions({ subject, actions,
      events: [event('released', ['environment']), event('machine-ready', ['machine'])], machineId: 'runner' });
    expect(options.map(option => [option.id, option.relation, option.setupRequired])).toEqual([
      ['event:acme.deploy/released', 'event', true], ['action:after:deployments.deploy', 'after', false],
    ]);
    expect(options[1]).toMatchObject({ subject, when: { kind: 'action', phase: 'after',
      actionIds: ['deployments.deploy'], subject }, trigger: { kind: 'action', phase: 'after',
      actionIds: ['deployments.deploy'], subject, enabled: true } });
    expect(options[1]?.trigger).not.toHaveProperty('filter');
    expect(options[0]).toMatchObject({ subject, trigger: null,
      when: { kind: 'pluginEvent', value: null, eventRef: { pluginId: 'acme.deploy', localId: 'released' } },
      eventSeed: { eventRef: { pluginId: 'acme.deploy', localId: 'released' }, monitoringMachineId: 'runner', setupInput: {} } });
    expect(buildResourceWorkflowTriggerStartOptions({ subject: { kind: 'machine', serverId: 'home', machineId: 'runner' },
      actions, events: [], machineId: 'runner' })).toEqual([]);
    expect(buildResourceWorkflowTriggerStartOptions({ subject: { kind: 'app', serverId: 'home', projectSourceId: 'app' },
      actions, events: [], machineId: 'runner' }).map(option => option.id)).toEqual(['action:after:deployments.deploy']);
  });

  it('uses the Environment’s configured Backup stream as the exact subject of its Backup completion', () => {
    const backup = { ...subject, kind: 'backup' } as const;
    const saved = event('backup-succeeded', ['environment', 'machine']);
    const backupCompleted = { ...saved, automation: PluginEventAutomationDeclarationV1Schema.parse({
      ...saved.automation, subjectKinds: ['backup', 'environment', 'machine'],
      completesActionIds: ['deployments.backups.run'], completionOutcome: 'succeeded',
    }) };
    const params = { subject, actions: [], events: [backupCompleted], machineId: 'runner', contextSubjects: [backup] };
    expect(buildResourceWorkflowTriggerStartOptions(params)).toMatchObject([{ subject: backup }]);
  });

  it('matches plugin Action and Event kinds from their qualified public declarations, excluding unrelated or undeclared Events', () => {
    const pluginSubject = { kind: 'plugin', serverId: 'home', pluginId: 'acme.deploy',
      subjectKindId: 'release', identity: { id: 'release-1' } } as const;
    const declared = { ...event('released', []), automation: { ...event('released', []).automation,
      subjects: [{ kind: 'plugin' as const, subjectKindId: 'release', identityField: '/release' }] } };
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {}, actionsById: {
      'acme.deploy/ship': { id: 'ship', pluginId: 'acme.deploy', occurrenceId: 'runtime', title: 'Ship',
        scopes: ['global'], surfaces: ['agent'], execution: { target: 'daemon' }, dangerLevel: 'safe' },
    } });
    const discovery: ActionDiscoveryDefinitionSummaryV1[] = [{ ...action, id: 'acme.deploy/actions/ship',
      approvalScope: { kind: 'plugin', subjectKindId: 'release', identityField: '/release' },
      automation: { before: true, after: true, workflowStep: true, subjectKinds: ['plugin'] } }];
    const actions = listWorkflowStepActionSpecs(projection, null, undefined, discovery, 'automation');
    const options = buildResourceWorkflowTriggerStartOptions({ subject: pluginSubject, actions, machineId: 'runner',
      events: [declared, { ...declared, eventRef: { pluginId: 'other.plugin', localId: 'released' } },
        { ...declared, eventRef: { pluginId: 'acme.deploy', localId: 'undeclared' }, automation: undefined }] });
    expect(options.map(option => option.id)).toEqual(['event:acme.deploy/released',
      'action:before:acme.deploy/actions/ship', 'action:after:acme.deploy/actions/ship']);
    expect(buildResourceWorkflowTriggerStartOptions({ subject: { ...pluginSubject, subjectKindId: 'other-kind' },
      actions, events: [declared], machineId: 'runner' })).toEqual([]);
  });
});
