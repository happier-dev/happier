import { describe, expect, it } from 'vitest';
import { derivePluginSessionInputLocalIdV1 } from '@happier-dev/protocol';

import {
  buildAutomationSessionInputAdmissionV1,
  buildAgentRuntimeFirstInputAdmissionV1,
  buildPluginSessionInputAdmissionV1,
  buildSessionSpawnInitialInputAdmissionForLocalIdV1,
  deriveAutomationSessionInputLocalIdV1,
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
