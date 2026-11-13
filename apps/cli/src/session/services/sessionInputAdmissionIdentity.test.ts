import { describe, expect, it } from 'vitest';
import { derivePluginSessionInputLocalIdV1, SessionInputRequestV1Schema, settleSessionInputRequestV1, type ActionCaller } from '@happier-dev/protocol';
import { settleSessionMessageProvenanceV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveSessionInputActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { buildSessionCreationCorrespondence } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';

import {
  buildAutomationSessionInputAdmissionV1,
  buildWorkflowSessionInputAdmissionV2,
  buildAgentRuntimeFirstInputAdmissionV1,
  buildCausalSessionInputAdmissionV1,
  buildPluginSessionInputAdmissionV1,
  buildSessionSpawnInitialInputAdmissionForLocalIdV1,
  deriveAutomationSessionInputLocalIdV1,
  deriveWorkflowSessionInputLocalIdV2,
  requiresMachineAdmissionForSessionInput,
  resolveSessionInputTargetMachineId,
} from './sessionInputAdmissionIdentity';

it.each(['raw', 'metadata'] as const)('targets the resumed Session using its %s Machine rather than its creation recipe', source => {
  const sessionCreationCorrespondenceV1 = buildSessionCreationCorrespondence({
    identity: { callerCreationNamespace: 'approval-delivery', creationKey: 'resumed-session' },
    recipe: { execution: { machineId: 'birth-machine', directory: { kind: 'path', path: '/repo' } },
      organization: { folderId: null, tagIds: [] },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
  });
  const input = { rawSession: source === 'raw' ? { machineId: 'resumed-machine' } : {},
    decryptedMetadata: { sessionCreationCorrespondenceV1, ...(source === 'metadata' ? { machineId: 'resumed-machine' } : {}) } };
  expect(resolveSessionInputTargetMachineId(input)).toBe('resumed-machine');
  expect(resolveSessionInputTargetMachineId({ ...input, targetMachineId: 'resumed-machine' })).toBe('resumed-machine');
  expect(resolveSessionInputTargetMachineId({ ...input, targetMachineId: 'birth-machine' })).toBeNull();
});

describe('derivePluginSessionInputLocalIdV1', () => {
  it('keeps a human-origin return on Account admission for encrypted input', () => {
    const request = SessionInputRequestV1Schema.parse({ v: 1, producer: 'happierApp', caller: { kind: 'host' }, permission: {},
      replyIntent: { mode: 'return', humanOrigin: { sessionId: 'composer-session' } } });
    expect(requiresMachineAdmissionForSessionInput({ request, mode: 'e2ee' })).toBe(false);
    expect(requiresMachineAdmissionForSessionInput({ request: { ...request, replyIntent: { mode: 'wait' } }, mode: 'e2ee' })).toBe(true);
  });
  const caller = {
    kind: 'plugin' as const,
    pluginId: 'acme.channels',
    contributionLocalId: 'inbound',
  };

  it.each([
    { kind: 'host' },
    { kind: 'session', sessionId: 'parent-session', starterDepth: 0, turnDepth: 0 },
    { kind: 'plugin', pluginId: 'acme.channels', contributionLocalId: 'inbound' },
    { kind: 'automationRun', automationId: 'automation', runId: 'run', cause: { kind: 'manual', invokedAt: 1 } },
  ] satisfies ActionCaller[])('retains the admitted requester through a $kind spawn first input', actionCaller => {
    const cause = { requestRef: 'original-parent-input', requester: { serverId: 'home', accountId: 'person' },
      persona: { serverId: 'home', sessionId: 'parent-session' }, origin: null };
    const first = buildSessionSpawnInitialInputAdmissionForLocalIdV1({ actionCaller,
      callerSurface: 'agent', callerAuthority: 'present_user', localId: 'child-first-input', actionRequestAttributionV1: cause });
    const inputAdmissionReceipt = { v: 1, issuer: 'authenticatedMachine' } as const;
    const authority = settleSessionInputRequestV1({ request: first.inputAdmission.request,
      currentSessionPermissionCeiling: 'default', inputAdmissionReceipt });
    const derived = deriveSessionInputActionRequestAttributionV1({ requestRef: first.localId,
      persona: { serverId: 'home', sessionId: 'child-session' }, origin: null,
      messageRole: 'user', inputAuthority: authority, inputAdmissionReceipt });
    expect(derived).toEqual(cause);
    expect(derived).not.toBe(cause);
    expect(first).not.toHaveProperty('executionAuthority');
  });

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
        displayNameSnapshot: 'Telegram · Release planning',
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
        displayNameSnapshot: 'Telegram · Release planning',
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

  it.each([undefined, { discussionId: 'discussion', messageId: 'question', throughSeq: 3,
    participantSessionId: 'source-session' }])('builds causal cross-Session admission retaining its Discussion witness (%j)', discussionAddressing => {
    const sourceSession = { sourceSessionId: 'source-session', sourceTurnId: 'source-turn', sourceInputId: 'source-input',
      via: 'mcp' as const, ...(discussionAddressing ? { discussionAddressing } : {}) };
    expect(buildCausalSessionInputAdmissionV1({
      ...sourceSession,
      callerDepth: 3,
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
        sourceSession,
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

describe('host-caller first input provenance (D15)', () => {
  const owner = { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'person', sessionRelationship: 'owner' } as const;
  const machine = { v: 1, issuer: 'authenticatedMachine' } as const;
  const requester = { requestRef: 'spawn-first-turn:typed', requester: { serverId: 'home', accountId: 'person' },
    persona: { serverId: 'home', sessionId: 'new-session' }, origin: null };
  const settle = (
    admission: ReturnType<typeof buildSessionSpawnInitialInputAdmissionForLocalIdV1>['inputAdmission'],
    receipt: typeof owner | typeof machine,
  ) => settleSessionMessageProvenanceV1({ request: admission.request, requestedProvenance: admission.provenance,
    inputAdmissionReceipt: receipt });

  it('attributes the words a present person typed into a new Session over the app RPC to that person', () => {
    const first = buildSessionSpawnInitialInputAdmissionForLocalIdV1({ actionCaller: { kind: 'host' },
      callerSurface: 'rpc', callerAuthority: 'present_user', localId: 'spawn-first-turn:typed' });
    expect(first.executionAuthority).toBe('present_user');
    expect(settle(first.inputAdmission, owner)).toEqual({ v: 1, kind: 'happierApp', actor: { kind: 'owner' } });
    // Encrypted send: Machine receipt plus the requester attribution the sender stamps for present_user.
    const sealed = { ...first.inputAdmission, request: { ...first.inputAdmission.request, actionRequestAttributionV1: requester } };
    expect(settle(sealed, machine)).toEqual({ v: 1, kind: 'happierApp', actor: { kind: 'person', accountId: 'person' } });
  });

  it.each([
    { name: 'an Agent Action', actionCaller: { kind: 'session', sessionId: 'parent', starterDepth: 0, turnDepth: 0 },
      callerSurface: 'agent', callerAuthority: 'account_automation' },
    { name: 'an unattended Account over RPC', actionCaller: { kind: 'host' }, callerSurface: 'rpc', callerAuthority: 'account_automation' },
    { name: 'a descendant of another request', actionCaller: { kind: 'host' }, callerSurface: 'rpc', callerAuthority: 'present_user',
      actionRequestAttributionV1: requester },
  ] satisfies ReadonlyArray<Omit<Parameters<typeof buildSessionSpawnInitialInputAdmissionForLocalIdV1>[0], 'localId'> & { name: string }>)(
    'keeps host provenance for first input from $name', ({ name: _name, ...params }) => {
      const first = buildSessionSpawnInitialInputAdmissionForLocalIdV1({ ...params, localId: 'spawn-first-turn:host' });
      expect(settle(first.inputAdmission, params.actionRequestAttributionV1 ? machine : owner))
        .toEqual({ v: 1, kind: 'host', producer: 'sessionAction' });
    });
});
