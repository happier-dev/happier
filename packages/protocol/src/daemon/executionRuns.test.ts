import { describe, expect, it } from 'vitest';

import {
  DaemonExecutionRunListResponseSchema,
  DaemonExecutionRunMarkerSchema,
  normalizePersistedExecutionRunConnectedServicesLaunchV1,
} from './executionRuns.js';

describe('DaemonExecutionRunMarkerSchema', () => {
  it('accepts and normalizes the exact remote-dev persisted launch shape without retaining predecessor-only identity fields', () => {
    const connectedServiceSelectionsJson = JSON.stringify([{
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: 'team',
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    }]);
    const parsed = DaemonExecutionRunMarkerSchema.parse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_22222222-2222-4222-8222-222222222222',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'running',
      startedAtMs: 0,
      updatedAtMs: 1,
      // Exact remote-dev@165a9365… persisted contract from runsBridge/contract.ts.
      executionRunConnectedServicesLaunchV1: {
        v: 1,
        runKey: 'execution_run:11111111-1111-4111-8111-111111111111',
        agentId: 'codex',
        connectedServicesBindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'team' },
          },
        },
        brokerSelectionIdentity: 'broker:team',
        runtimeAccountIdentitySelections: [{
          serviceId: 'openai-codex',
          profileId: 'team',
          groupId: null,
          groupGeneration: null,
          providerAccountId: 'acct-team',
          accountLabel: null,
          source: 'spawn_selection',
        }],
        connectedServiceSelectionsJson,
        sessionDirectory: '/workspace',
        materializedRoot: '/managed/materialized/execution_run_one',
      },
    });

    expect(
      normalizePersistedExecutionRunConnectedServicesLaunchV1(
        parsed.executionRunConnectedServicesLaunchV1,
      ),
    ).toEqual({
      source: 'remote_dev_predecessor',
      registration: {
        v: 1,
        runKey: 'execution_run:11111111-1111-4111-8111-111111111111',
        agentId: 'codex',
        materializationKey: 'execution_run:11111111-1111-4111-8111-111111111111',
        connectedServicesBindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'team' },
          },
        },
        connectedServiceSelectionsEnv: {
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: connectedServiceSelectionsJson,
        },
        sessionDirectory: '/workspace',
        materializedRoot: '/managed/materialized/execution_run_one',
      },
    });
    expect(parsed.executionRunConnectedServicesLaunchV1).not.toHaveProperty('materializationKey');
    expect(parsed.executionRunConnectedServicesLaunchV1).not.toHaveProperty('connectedServiceSelectionsEnv');
    expect(DaemonExecutionRunMarkerSchema.safeParse({
      ...parsed,
      executionRunConnectedServicesLaunchV1: {
        ...parsed.executionRunConnectedServicesLaunchV1,
        connectedServiceSelectionsJson: JSON.stringify([{
          kind: 'profile',
          serviceId: 'openai-codex',
          profileId: 'team',
          accessToken: 'must-not-survive',
        }]),
      },
    }).success).toBe(false);
    expect(DaemonExecutionRunMarkerSchema.safeParse({
      ...parsed,
      executionRunConnectedServicesLaunchV1: {
        ...parsed.executionRunConnectedServicesLaunchV1,
        connectedServicesBindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'team',
              accessToken: 'must-not-survive',
            },
          },
        },
      },
    }).success).toBe(false);
  });

  it('retains a strict non-secret execution-run connected-services launch fact', () => {
    const launch = {
      v: 1,
      activationId: '11111111-1111-4111-8111-111111111111',
      runKey: 'run_1',
      agentId: 'codex',
      materializationKey: 'run_1',
      connectedServicesBindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'profile_1' },
        },
      },
      connectedServiceSelectionsEnv: {
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
          kind: 'profile',
          serviceId: 'openai-codex',
          profileId: 'profile_1',
        }]),
      },
      sessionDirectory: '/tmp/project',
      materializedRoot: '/tmp/materialized/run_1/codex',
    };
    const parsed = DaemonExecutionRunMarkerSchema.parse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'running',
      startedAtMs: 0,
      updatedAtMs: 1,
      executionRunConnectedServicesLaunchV1: launch,
    });

    expect(parsed.executionRunConnectedServicesLaunchV1).toEqual(launch);
    expect(DaemonExecutionRunMarkerSchema.safeParse({
      ...parsed,
      executionRunConnectedServicesLaunchV1: {
        ...launch,
        activationId: 'pid-only-is-not-authority',
      },
    }).success).toBe(false);

    expect(DaemonExecutionRunMarkerSchema.safeParse({
      ...parsed,
      executionRunConnectedServicesLaunchV1: {
        ...launch,
        brokerCapability: {
          path: '/tmp/materialized/run_1/broker/capability.json',
          materializationId: 'run_1',
          selectionIdentityDigest: 'a'.repeat(64),
          capabilityDigest: 'b'.repeat(64),
        },
      },
    }).success).toBe(false);
    expect(DaemonExecutionRunMarkerSchema.safeParse({
      ...parsed,
      executionRunConnectedServicesLaunchV1: { ...launch, credential: 'must-not-persist' },
    }).success).toBe(false);
    expect(DaemonExecutionRunMarkerSchema.safeParse({
      ...parsed,
      executionRunConnectedServicesLaunchV1: {
        ...launch,
        connectedServiceSelectionsEnv: {
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'profile_1',
            refreshToken: 'must-not-persist',
          }]),
        },
      },
    }).success).toBe(false);
    expect(DaemonExecutionRunMarkerSchema.safeParse({
      ...parsed,
      executionRunConnectedServicesLaunchV1: {
        ...launch,
        connectedServiceSelectionsEnv: {
          ...launch.connectedServiceSelectionsEnv,
          OPENAI_API_KEY: 'must-not-persist',
        },
      },
    }).success).toBe(false);
    expect(DaemonExecutionRunMarkerSchema.safeParse({
      ...parsed,
      executionRunConnectedServicesLaunchV1: {
        ...launch,
        connectedServicesBindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'profile_1',
              refreshToken: 'must-not-persist',
            },
          },
        },
      },
    }).success).toBe(false);
  });
  it('rejects invalid resumeHandle shapes', () => {
    const parsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        // providerSessionId missing on purpose
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts a valid resumeHandle', () => {
    const parsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        providerSessionId: 'vendor-session-123',
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('reads legacy backend target fields in list responses and preserves additive transport fields', () => {
    const parsed = DaemonExecutionRunListResponseSchema.parse({
      runs: [
        {
          happyHomeDir: '/tmp/happy',
          pid: 123,
          happySessionId: 'session_1',
          runId: 'run_1',
          callId: 'call_1',
          sidechainId: 'side_1',
          intent: 'plan',
          backendId: 'codex',
          runClass: 'bounded',
          ioMode: 'request_response',
          retentionPolicy: 'resumable',
          status: 'succeeded',
          startedAtMs: 0,
          updatedAtMs: 1,
          extraTransportField: 'keep-me',
        },
      ],
    });

    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]?.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    });
    expect((parsed.runs[0] as any).extraTransportField).toBe('keep-me');
  });

  it('accepts legacy backendId fields in markers and resume handles', () => {
    const parsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendId: 'codex',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendId: 'codex',
        providerSessionId: 'vendor-session-123',
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw parsed.error;
    }
    expect(parsed.data.backendTarget).toEqual({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' });
    expect(parsed.data.resumeHandle).toMatchObject({
      kind: 'provider_session.v1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      providerSessionId: 'vendor-session-123',
    });
  });

  it('accepts legacy configured backend provenance in markers and resume handles', () => {
    const parsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendId: 'review-bot',
      sourceKind: 'configured',
      configuredBackendId: 'review-bot',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendId: 'review-bot',
        sourceKind: 'configured',
        configuredBackendId: 'review-bot',
        providerSessionId: 'vendor-session-123',
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw parsed.error;
    }
    expect(parsed.data.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
    expect(parsed.data.resumeHandle).toMatchObject({
      kind: 'provider_session.v1',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      providerSessionId: 'vendor-session-123',
    });
  });

  it('accepts canonical V2 backendTarget input in markers and list responses', () => {
    const markerParsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
    });

    expect(markerParsed.success).toBe(true);
    if (!markerParsed.success) {
      throw markerParsed.error;
    }
    expect(markerParsed.data.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });

    const listParsed = DaemonExecutionRunListResponseSchema.parse({
      runs: [
        {
          happyHomeDir: '/tmp/happy',
          pid: 123,
          happySessionId: 'session_1',
          runId: 'run_1',
          callId: 'call_1',
          sidechainId: 'side_1',
          intent: 'plan',
          backendTarget: {
            kind: 'backend',
            backendId: 'review-bot',
            configuredBackendId: 'review-bot',
            sourceKind: 'configured',
          },
          runClass: 'bounded',
          ioMode: 'request_response',
          retentionPolicy: 'resumable',
          status: 'succeeded',
          startedAtMs: 0,
          updatedAtMs: 1,
        },
      ],
    });

    expect(listParsed.runs[0]?.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
  });

  it('rejects ambiguous customAcp legacy backendId fields in markers', () => {
    const parsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendId: 'customAcp',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects legacy configured ACP flavor carriers in marker backend ids', () => {
    const parsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendId: 'acp:review-bot',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects marker entries that use builtIn customAcp as a concrete backend target', () => {
    const parsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
    });

    expect(parsed.success).toBe(false);
  });
});
