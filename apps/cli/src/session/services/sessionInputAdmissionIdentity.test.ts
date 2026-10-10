import { describe, expect, it } from 'vitest';
import { derivePluginSessionInputLocalIdV1 } from '@happier-dev/protocol';

import {
  buildAutomationSessionInputAdmissionV1,
  buildWorkflowSessionInputAdmissionV2,
  buildAgentRuntimeFirstInputAdmissionV1,
  buildCausalSessionInputAdmissionV1,
  buildPluginSessionInputAdmissionV1,
  buildSessionSpawnInitialInputAdmissionForLocalIdV1,
  deriveAutomationSessionInputLocalIdV1,
  deriveWorkflowSessionInputLocalIdV2,
} from './sessionInputAdmissionIdentity';

describe('derivePluginSessionInputLocalIdV1', () => {
  const caller = {
    kind: 'plugin' as const,
    pluginId: 'acme.channels',
    contributionLocalId: 'inbound',
  };

  it('derives one stable bounded Pending identity from caller, Session, and exact public key', () => {
    const first = derivePluginSessionInputLocalIdV1({
      caller,
      sessionId: 'session-1',
      idempotencyKey: 'message-42',
    });
    const retry = derivePluginSessionInputLocalIdV1({
      caller,
      sessionId: 'session-1',
      idempotencyKey: 'message-42',
    });

    expect(first).toBe(retry);
    expect(first).toMatch(/^plugin-input-v1:[A-Za-z0-9_-]{43}$/u);
  });

  it('separates caller, contribution, Session, and exact-key namespaces', () => {
    const derive = (overrides: Partial<Parameters<typeof derivePluginSessionInputLocalIdV1>[0]>) => (
      derivePluginSessionInputLocalIdV1({
        caller,
        sessionId: 'session-1',
        idempotencyKey: 'message-42',
        ...overrides,
      })
    );
    const baseline = derive({});

    expect(derive({ caller: { ...caller, pluginId: 'acme.other' } })).not.toBe(baseline);
    expect(derive({ caller: { ...caller, contributionLocalId: 'outbound' } })).not.toBe(baseline);
    expect(derive({ sessionId: 'session-2' })).not.toBe(baseline);
    expect(derive({ idempotencyKey: 'message-43' })).not.toBe(baseline);
  });

  it('rejects missing contribution identity and malformed public keys', () => {
    expect(() => derivePluginSessionInputLocalIdV1({
      caller: { pluginId: 'acme.channels' },
      sessionId: 'session-1',
      idempotencyKey: 'message-42',
    })).toThrow();
    expect(() => derivePluginSessionInputLocalIdV1({
      caller,
      sessionId: 'session-1',
      idempotencyKey: 'e\u0301',
    })).toThrow();
  });

  it('builds descriptive provenance and protected request only from host-stamped caller facts', () => {
    expect(buildPluginSessionInputAdmissionV1({
      caller,
      surface: 'mcp',
      source: {
        sourceRef: 'channel-7',
        sourceRevisionOrEpoch: 'message-42',
        remoteApprovalMaxScope: 'request',
        requestedPermissionCeiling: 'read-only',
        externalActor: { kind: 'human', displayNameSnapshot: 'Ada' },
        contentProvenance: 'forwarded',
      },
    })).toEqual({
      provenance: {
        v: 1,
        kind: 'pluginSession',
        pluginId: 'acme.channels',
        contributionLocalId: 'inbound',
        surface: 'mcp',
        sourceRef: 'channel-7',
        sourceRevisionOrEpoch: 'message-42',
        externalActor: { kind: 'human', displayNameSnapshot: 'Ada' },
        contentProvenance: 'forwarded',
      },
      request: {
        v: 1,
        producer: 'pluginSession',
        caller: {
          kind: 'plugin',
          pluginId: 'acme.channels',
          contributionLocalId: 'inbound',
        },
        sourceAuthority: {
          mediatorPluginId: 'acme.channels',
          sourceRef: 'channel-7',
          sourceRevisionOrEpoch: 'message-42',
          remoteApprovalMaxScope: 'request',
        },
        permission: { requestedPermissionCeiling: 'read-only' },
      },
    });
  });

  it('builds causal cross-Session admission from the active host turn witness', () => {
    expect(buildCausalSessionInputAdmissionV1({
      sourceSessionId: 'source-session',
      sourceTurnId: 'source-turn',
      callerDepth: 3,
      via: 'mcp',
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'read-only',
      },
    })).toEqual({
      provenance: {
        v: 1,
        kind: 'happierSession',
        sourceSessionId: 'source-session',
        via: 'mcp',
        callerDepth: 3,
      },
      request: {
        v: 1,
        producer: 'happierMcp',
        caller: { kind: 'host' },
        sourceSession: {
          sourceSessionId: 'source-session',
          sourceTurnId: 'source-turn',
          via: 'mcp',
        },
        permission: { requestedPermissionCeiling: 'read-only' },
      },
    });
  });

  it('rejects caller depths outside the canonical persisted integer contract', () => {
    expect(() => buildCausalSessionInputAdmissionV1({
      sourceSessionId: 'source-session', sourceTurnId: 'source-turn', via: 'mcp',
      callerDepth: 2_147_483_648,
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
    })).toThrow();
  });

  it('retains the host-sealed spawn identity while preserving real plugin provenance', () => {
    const first = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
      actionCaller: caller,
      callerSurface: 'plugin',
      localId: 'spawn-first-turn:stable-creation',
    });
    const renamedContribution = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
      actionCaller: { ...caller, contributionLocalId: 'renamed-inbound' },
      callerSurface: 'plugin',
      localId: 'spawn-first-turn:stable-creation',
    });

    expect(first.localId).toBe(renamedContribution.localId);
    expect(first.inputAdmission).toMatchObject({
      provenance: {
        kind: 'pluginSession',
        pluginId: 'acme.channels',
        contributionLocalId: 'inbound',
      },
      request: {
        producer: 'pluginSession',
        caller,
        permission: {},
      },
    });
  });

  it('does not invent an owner or a requested ceiling for a host UI spawn input', () => {
    expect(buildSessionSpawnInitialInputAdmissionForLocalIdV1({
      actionCaller: { kind: 'host' },
      callerSurface: 'ui',
      localId: 'spawn-first-turn:host-ui',
    }).inputAdmission).toEqual({
      provenance: {
        v: 1,
        kind: 'host',
        producer: 'happierApp',
      },
      request: {
        v: 1,
        producer: 'happierApp',
        caller: { kind: 'host' },
        permission: {},
      },
    });
  });

  it('retains exact Automation Run provenance for a spawned Session initial input', () => {
    const admission = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
      actionCaller: {
        kind: 'automationRun',
        automationId: 'automation-7',
        runId: 'run-42',
        cause: { kind: 'manual', invokedAt: 1 },
      },
      callerSurface: 'cli',
      localId: 'spawn-first-turn:automation',
    });

    expect(admission).toMatchObject({
      localId: expect.any(String),
      inputAdmission: {
        provenance: {
          v: 1,
          kind: 'automation',
          automationId: 'automation-7',
          runId: 'run-42',
        },
        request: {
          v: 1,
          producer: 'automation',
          caller: { kind: 'host' },
          automation: {
            automationId: 'automation-7',
            runId: 'run-42',
          },
          permission: {},
        },
      },
    });
  });

  it('derives a stable Automation Pending identity and machine-only protected admission facts', () => {
    expect(deriveAutomationSessionInputLocalIdV1({
      automationId: 'automation-7',
      runId: 'run-42',
    })).toBe('automation:run:run-42');
    expect(buildAutomationSessionInputAdmissionV1({
      automationId: 'automation-7',
      runId: 'run-42',
    })).toEqual({
      provenance: {
        v: 1,
        kind: 'automation',
        automationId: 'automation-7',
        runId: 'run-42',
      },
      request: {
        v: 1,
        producer: 'automation',
        caller: { kind: 'host' },
        automation: {
          automationId: 'automation-7',
          runId: 'run-42',
        },
        permission: {},
      },
    });
  });

  it('stamps the step\'s visible ordinal on its provenance and binds it to the protected request (transcript step number)', async () => {
    const { deriveWorkflowSessionInputLocalIdV2 } = await import('@happier-dev/protocol');
    const workflow = { purpose: 'invocation' as const, runId: 'workflow-run-42', invocationRecordId: 'workflow-invocation-7', stepOrdinal: '4' };
    const admission = buildWorkflowSessionInputAdmissionV2(workflow);
    expect(admission.provenance).toMatchObject({ kind: 'workflow_invocation', stepOrdinal: '4' });
    expect(admission.request.workflow).toMatchObject({ stepOrdinal: '4' });
    // The number is presentation: the durable input identity is the same with or without it.
    const { stepOrdinal: _ordinal, ...unnumbered } = workflow;
    expect(deriveWorkflowSessionInputLocalIdV2(workflow)).toBe(deriveWorkflowSessionInputLocalIdV2(unnumbered));
  });

  it('builds stable exact Workflow invocation Session admissions without an Automation id', () => {
    const invocation = buildWorkflowSessionInputAdmissionV2({
      runId: 'workflow-run-42',
      purpose: 'invocation',
      invocationRecordId: 'workflow-invocation-7',
    }, {
      requestedPermissionCeiling: 'read-only',
      sourceAuthority: {
        mediatorPluginId: 'happier.channels',
        sourceRef: 'channels:binding:binding-1',
        sourceRevisionOrEpoch: '4:7',
        remoteApprovalMaxScope: 'session',
      },
    });

    expect(invocation).toEqual({
      provenance: {
        v: 2,
        kind: 'workflow_invocation',
        runId: 'workflow-run-42',
        invocationRecordId: 'workflow-invocation-7',
      },
      request: {
        v: 2,
        producer: 'workflow',
        caller: { kind: 'host' },
        sourceAuthority: {
          mediatorPluginId: 'happier.channels',
          sourceRef: 'channels:binding:binding-1',
          sourceRevisionOrEpoch: '4:7',
          remoteApprovalMaxScope: 'session',
        },
        workflow: {
          purpose: 'invocation',
          runId: 'workflow-run-42',
          invocationRecordId: 'workflow-invocation-7',
        },
        permission: { requestedPermissionCeiling: 'read-only' },
      },
    });
    expect(deriveWorkflowSessionInputLocalIdV2({
      runId: 'workflow-run-42',
      purpose: 'invocation',
      invocationRecordId: 'workflow-invocation-7',
    })).toBe(deriveWorkflowSessionInputLocalIdV2({
      runId: 'workflow-run-42',
      purpose: 'invocation',
      invocationRecordId: 'workflow-invocation-7',
    }));
    expect(deriveWorkflowSessionInputLocalIdV2({
      runId: 'workflow-run-42',
      purpose: 'invocation',
      invocationRecordId: 'workflow-invocation-7',
    })).not.toBe(deriveWorkflowSessionInputLocalIdV2({
      runId: 'workflow-run-42',
      purpose: 'invocation',
      invocationRecordId: 'workflow-invocation-other',
    }));
  });

  it('keeps daemon first input distinct from a UI-originated host request', () => {
    expect(buildAgentRuntimeFirstInputAdmissionV1()).toEqual({
      provenance: {
        v: 1,
        kind: 'host',
        producer: 'agentRuntimeFirstInput',
      },
      request: {
        v: 1,
        producer: 'agentRuntimeFirstInput',
        caller: { kind: 'host' },
        permission: {},
      },
    });
  });
});
