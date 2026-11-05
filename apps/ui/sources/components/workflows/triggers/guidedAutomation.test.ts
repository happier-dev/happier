import { describe, expect, it, vi } from 'vitest';
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
  describeGuidedAutomation,
  guidedApprovalProfileId,
  guidedStarterDraft,
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

  it('reads the answers back from the same answers it writes: the event or schedule, the subject, the Then and the channels', () => {
    const event = describeGuidedAutomation(
      draft({ when: healthEvent, mode: 'propose' }),
      { subjectName: 'eadc', channelLabels: [] },
    );
    expect(event).toContain('guided.readBack.propose');
    expect(event).toContain('event=API health check');
    expect(event).toContain('subject=eadc');
    expect(event).toContain('guided.readBack.tellInbox');
    const scheduled = describeGuidedAutomation(
      draft({ mode: 'chain', channels: ['push'] }),
      { subjectName: 'eadc', channelLabels: ['Push'] },
    );
    expect(scheduled).toContain('guided.readBack.chain');
    expect(scheduled).toContain('summary.everyDayAt');
    expect(scheduled).toContain('channels=Push');
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
