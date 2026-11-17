import { describe, expect, it } from 'vitest';
import type { ActionDiscoveryDefinitionSummaryV1 } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { serializeActionSpec } from '@happier-dev/protocol/actions/actionCatalog';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { PluginEventAutomationDeclarationV1Schema } from '@happier-dev/protocol/automations/automationEventDeclarationV1';
import { listWorkflowStepActionSpecs } from '../presentation/workflowActionCatalog';
import { buildResourceWorkflowTriggerStartOptions } from './workflowTriggerStarts';

const subject = { kind: 'environment', serverId: 'home', environmentId: 'production' } as const;
const action = serializeActionSpec(getActionSpec('deployments.deploy'), { includeOutputSchema: false });
const event = (localId: string, subjectKinds: readonly ('environment' | 'machine')[]) => ({
  eventRef: { pluginId: 'acme.deploy', localId }, title: localId, pluginName: 'Deploy',
  automation: PluginEventAutomationDeclarationV1Schema.parse({ v: 1, eligible: true, subjectKinds,
    source: { sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull'],
      sourceConfigSchema: { type: 'object' }, setupActionRef: { pluginId: 'acme.deploy', localId: 'setup' } } }),
});

describe('resource Link When choices', () => {
  it('uses admitted phase and subject metadata, with one after row and declared Events requiring source setup', () => {
    const discovery: ActionDiscoveryDefinitionSummaryV1[] = [{ ...action, automation: { before: false, after: true, workflowStep: true,
      subjectKinds: ['environment', 'app'] } }];
    const actions = listWorkflowStepActionSpecs(null, null, undefined, discovery, 'automation');
    const options = buildResourceWorkflowTriggerStartOptions({ subject, actions,
      events: [event('released', ['environment']), event('machine-ready', ['machine'])], machineId: 'runner' });
    expect(options.map(option => [option.id, option.relation, option.setupRequired])).toEqual([
      ['action:after:deployments.deploy', 'after', false], ['event:acme.deploy/released', 'event', true],
    ]);
    expect(options[0]).toMatchObject({ subject, when: { kind: 'action', phase: 'after',
      actionIds: ['deployments.deploy'], subject }, trigger: { kind: 'action', phase: 'after',
      actionIds: ['deployments.deploy'], subject, enabled: true } });
    expect(options[0]?.trigger).not.toHaveProperty('filter');
    expect(options[1]).toMatchObject({ subject, trigger: null,
      when: { kind: 'pluginEvent', value: null, eventRef: { pluginId: 'acme.deploy', localId: 'released' } },
      eventSeed: { eventRef: { pluginId: 'acme.deploy', localId: 'released' }, monitoringMachineId: 'runner', setupInput: {} } });
    expect(buildResourceWorkflowTriggerStartOptions({ subject: { kind: 'machine', serverId: 'home', machineId: 'runner' },
      actions, events: [], machineId: 'runner' })).toEqual([]);
    expect(buildResourceWorkflowTriggerStartOptions({ subject: { kind: 'app', serverId: 'home', projectSourceId: 'app' },
      actions, events: [], machineId: 'runner' }).map(option => option.id)).toEqual(['action:after:deployments.deploy']);
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
    expect(options.map(option => option.id)).toEqual(['action:before:acme.deploy/actions/ship',
      'action:after:acme.deploy/actions/ship', 'event:acme.deploy/released']);
    expect(buildResourceWorkflowTriggerStartOptions({ subject: { ...pluginSubject, subjectKindId: 'other-kind' },
      actions, events: [declared], machineId: 'runner' })).toEqual([]);
  });
});
