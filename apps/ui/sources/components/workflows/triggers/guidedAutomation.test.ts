import { describe, expect, it, vi } from 'vitest';
import { readApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { WorkflowTriggerAddRequestV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { AutomationTriggerDefinitionInputSchema } from '@happier-dev/protocol/automations/automationTriggerDefinition';

import type { GuidedAutomationDraft } from './guidedAutomation';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

const { createDefaultWhen } = await import('./sessionTriggerForm');
const {
  buildGuidedAutomationRequest,
  buildGuidedAutomationReadBack,
  guidedApprovalProfileId,
  guidedStarterDraft,
  guidedStarterEventSeed,
} = await import('./guidedAutomation');

const selection = {
  agentTarget: {
    kind: 'agent' as const,
    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
  },
};
const project = { machineId: 'eadc2422', directory: '~' };
const healthEventTrigger = AutomationTriggerDefinitionInputSchema.parse({
  kind: 'pluginEvent',
  enabled: true,
  sourceInstanceId: 'source-1',
  sourceContractVersion: 1,
  eventRef: {
    pluginId: 'happier.machine.services',
    localId: 'health-check-failed',
  },
  displayLabel: 'API health check',
  sourceConfig: {},
  filter: null,
  maximumObservationAgeMs: null,
  observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
    machineId: project.machineId, pluginId: 'happier.machine.services', materializationId: 'services-1',
  } },
});
if (healthEventTrigger.kind !== 'pluginEvent' || !('sourceInstanceId' in healthEventTrigger)) {
  throw new Error('Expected a configured health Event fixture');
}
const healthEvent = {
  kind: 'pluginEvent' as const,
  value: healthEventTrigger,
};

function draft(
  overrides: Partial<GuidedAutomationDraft> = {},
): GuidedAutomationDraft {
  return {
    when: createDefaultWhen('schedule'),
    lookAt: ['logs', 'health'],
    mode: 'investigate',
    selection,
    channels: [],
    ...overrides,
  };
}

function blocksOf(request: ReturnType<typeof buildGuidedAutomationRequest>) {
  return request?.target.kind === 'inline'
    ? request.target.definition.blocks
    : [];
}

describe('guided automation (four questions)', () => {
  it('reopens one canonical saved health source from every subject entry and carries Domain configure intent', () => {
    const domain = { domainId: 'public-domain', targetLinkId: 'serving-target' };
    const intent = { subject: { kind: 'environment' as const, environmentId: 'production', machineId: 'controller' },
      controllerMachineId: 'controller', domain };
    const environment = guidedStarterEventSeed('healthFailed', intent);
    const service = guidedStarterEventSeed('healthFailed', { subject: {
      kind: 'service', serviceId: 'systemd:api', machineId: 'watched' } });
    expect(environment).toMatchObject({ sourceInstanceId: expect.stringMatching(/^health:/),
      monitoringMachineId: 'controller', setupInput: { subject: { kind: 'environment', environmentId: 'production' }, domain } });
    expect(service).toMatchObject({ sourceInstanceId: expect.stringMatching(/^health:/),
      setupInput: { subject: { kind: 'machineService', machineId: 'watched', serviceId: 'systemd:api' } } });
    expect(environment?.sourceInstanceId).not.toBe(service?.sourceInstanceId);
  });
  it('reads the exact Event/filter, scope, controller, pending observation, effective profile and destination independently of notification selection', () => {
    const receipt = AutomationTriggerDefinitionInputSchema.parse({ ...healthEventTrigger,
      eventRef: { pluginId: 'happier.machine.services', localId: 'deployment-failed' },
      sourceConfig: { v: 1, serverId: 'home', environmentId: 'production', targetLinkId: 'platform',
        observingSince: 1, credentialPrincipal: { kind: 'account', accountId: 'owner',
          purpose: { consumer: { pluginId: 'example.deploy', localId: 'selection' }, purpose: 'action-account' },
          target: { kind: 'account', account: { service: { pluginId: 'example.deploy', localId: 'account' }, accountId: 'provider-account' } } } },
      filter: { v: 1, all: [{ op: 'eq', field: '/phase', value: 'build' }] },
    });
    if (receipt.kind !== 'pluginEvent' || !('sourceInstanceId' in receipt)) throw new Error('Expected configured Event');
    const configured = draft({ when: { kind: 'pluginEvent', value: receipt }, mode: 'apply', approvalProfileId: 'deleted-profile' });
    const facts = { subjectName: 'Production', project,
      deploymentEnvironment: { serverId: 'home', projectSourceId: 'source-app', environmentId: 'production' },
      controller: { machineId: 'controller', online: false }, approval: readApprovalProfileV1({ approvalProfiles: [] }, configured.approvalProfileId!) };
    const readBack = buildGuidedAutomationReadBack(configured, facts);
    expect(readBack).toMatchObject({
      wake: receipt, deploymentEnvironment: facts.deploymentEnvironment, controller: facts.controller,
      pendingObservation: { periodMs: null },
      approval: { resolution: { status: 'missing', requestedId: 'deleted-profile', effectiveId: 'builtin:read-propose' } },
      disclosure: { inbox: true, channelIds: [] },
    });
    const withoutAgent = { ...configured, selection: undefined };
    expect(buildGuidedAutomationRequest(withoutAgent, facts)).toBeNull();
    expect(buildGuidedAutomationReadBack(withoutAgent, facts)).toEqual(readBack);
    const notified = buildGuidedAutomationReadBack({ ...configured, channels: ['push'] }, facts);
    expect(notified?.wake).toEqual(readBack?.wake);
    expect(notified?.disclosure.channelIds).toEqual(['push']);
    const config = receipt.sourceConfig;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Expected receipt source configuration');
    const observed = { ...receipt, sourceConfig: { ...config, periodMs: 300000 } };
    expect(buildGuidedAutomationReadBack({ ...configured, when: { kind: 'pluginEvent', value: observed } }, facts)
      ?.pendingObservation).toEqual({ periodMs: 300000 });
    const rollback = { ...observed, eventRef: { ...observed.eventRef, localId: 'rollback-completed' } };
    expect(buildGuidedAutomationReadBack({ ...configured, when: { kind: 'pluginEvent', value: rollback } }, facts)
      ?.pendingObservation).toEqual({ periodMs: 300000 });
    const local = { ...observed, sourceConfig: { v: 1, serverId: 'home', environmentId: 'production', observingSince: 1, periodMs: 300000 } };
    expect(buildGuidedAutomationReadBack({ ...configured, when: { kind: 'pluginEvent', value: local } }, facts)
      ?.pendingObservation).toBeNull();
    expect(buildGuidedAutomationReadBack({ ...configured, when: healthEvent }, facts)?.pendingObservation).toBeNull();
    expect(buildGuidedAutomationReadBack(draft(), { subjectName: 'Production', project })).toMatchObject({
      approval: null, pendingObservation: null, controller: null,
    });
  });
  it('writes one ordinary trigger: When, a fresh Session with the answers as its prompt, and the mode as its approval profile', () => {
    const request = buildGuidedAutomationRequest(draft(), {
      subjectName: 'eadc',
      project,
    });
    expect(WorkflowTriggerAddRequestV1Schema.safeParse(request).success).toBe(
      true,
    );
    expect(request).toMatchObject({
      project,
      trigger: { kind: 'schedule' },
      executionTarget: { kind: 'session' },
      approvalProfileId: 'builtin:read-propose',
    });
    expect(blocksOf(request)).toHaveLength(1);
    // Its rows and Library entry name it by what it does, not "Send a prompt".
    expect(blocksOf(request)[0]).toMatchObject({ kind: 'step', name: 'workflows.triggers.guided.mode.investigate' });
  });

  it('maps each Then to the approval profile that enforces it, never a copy of its rules', () => {
    const profile = (mode: GuidedAutomationDraft['mode']) =>
      buildGuidedAutomationRequest(draft({ mode }), {
        subjectName: 'eadc',
        project,
      })?.approvalProfileId;
    expect([
      profile('investigate'),
      profile('propose'),
      profile('apply'),
      profile('chain'),
    ]).toEqual([
      'builtin:read-propose',
      'builtin:read-propose',
      'builtin:apply-safe',
      'builtin:apply-safe',
    ]);
  });

  it('chains investigator, fixer and reviewer as three steps, and adds a Notify me step only for channels beyond the Inbox', () => {
    expect(
      blocksOf(
        buildGuidedAutomationRequest(draft({ mode: 'chain' }), {
          subjectName: 'eadc',
          project,
        }),
      ),
    ).toHaveLength(3);
    const told = buildGuidedAutomationRequest(
      draft({ mode: 'chain', channels: ['push'] }),
      { subjectName: 'eadc', project },
    );
    const blocks = blocksOf(told);
    expect(blocks).toHaveLength(4);
    expect(blocks[3]).toMatchObject({
      kind: 'action',
      actionId: 'notifications.notify_me',
      input: { channels: { kind: 'literal', value: ['push'] } },
    });
    expect(WorkflowTriggerAddRequestV1Schema.safeParse(told).success).toBe(
      true,
    );
  });

  it('is incomplete until When, Look at and an Agent are answered', () => {
    expect(
      buildGuidedAutomationRequest(draft({ lookAt: [] }), {
        subjectName: 'eadc',
        project,
      }),
    ).toBeNull();
    expect(
      buildGuidedAutomationRequest(draft({ selection: undefined }), {
        subjectName: 'eadc',
        project,
      }),
    ).toBeNull();
    expect(
      buildGuidedAutomationRequest(
        draft({ when: { kind: 'pluginEvent', value: null } }),
        { subjectName: 'eadc', project },
      ),
    ).toBeNull();
    expect(
      buildGuidedAutomationRequest(draft({ when: healthEvent }), {
        subjectName: 'eadc',
        project,
      }),
    ).not.toBeNull();
  });

  it('opens a starter with its When and Then already answered', () => {
    expect(guidedStarterDraft('nightly', selection)).toMatchObject({
      when: { kind: 'schedule', schedule: { repeat: 'daily', hour: 3 } },
      mode: 'investigate',
    });
    expect(guidedStarterDraft('healthFailed', selection)).toMatchObject({
      mode: 'propose',
      when: {
        kind: 'pluginEvent',
        value: null,
        eventRef: {
          pluginId: 'happier.machine.services',
          localId: 'health-check-failed',
        },
      },
    });
  });

  it('attaches the chosen approval profile, and the Then\'s own profile until one is chosen', () => {
    expect(buildGuidedAutomationRequest(draft({ mode: 'apply' }), { subjectName: 'eadc', project })?.approvalProfileId)
      .toBe('builtin:apply-safe');
    expect(guidedApprovalProfileId(draft({ mode: 'apply' }))).toBe('builtin:apply-safe');
    const chosen = draft({ mode: 'apply', approvalProfileId: 'custom:night-ops' });
    expect(buildGuidedAutomationRequest(chosen, { subjectName: 'eadc', project })?.approvalProfileId).toBe('custom:night-ops');
    expect(guidedApprovalProfileId(chosen)).toBe('custom:night-ops');
  });
});
