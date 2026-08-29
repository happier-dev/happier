import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  DaemonExecutionRunListResponseSchema,
  DaemonExecutionRunMarkerPersistenceReadSchema,
  DaemonExecutionRunMarkerOwnerWriteSchema,
  DaemonExecutionRunMarkerSchema,
  ExecutionRunConnectedServicesCleanupReceiptV1Schema,
  normalizePersistedExecutionRunConnectedServicesLaunchV1,
} from './executionRuns.js';
import {
  ExecutionRunConnectedServicesCleanupReceiptV1Schema as PublicExecutionRunConnectedServicesCleanupReceiptV1Schema,
  DaemonExecutionRunMarkerOwnerWriteSchema as PublicDaemonExecutionRunMarkerOwnerWriteSchema,
  type ExecutionRunConnectedServicesCleanupReceiptV1 as PublicExecutionRunConnectedServicesCleanupReceiptV1,
  type DaemonExecutionRunMarkerOwnerWrite as PublicDaemonExecutionRunMarkerOwnerWrite,
} from '../index.js';

describe('DaemonExecutionRunMarkerSchema', () => {
  it('publishes the owner-write marker and cleanup-receipt contracts from the Protocol root', () => {
    expect(PublicExecutionRunConnectedServicesCleanupReceiptV1Schema)
      .toBe(ExecutionRunConnectedServicesCleanupReceiptV1Schema);
    expect(PublicDaemonExecutionRunMarkerOwnerWriteSchema)
      .toBe(DaemonExecutionRunMarkerOwnerWriteSchema);
    expectTypeOf<PublicExecutionRunConnectedServicesCleanupReceiptV1>()
      .toEqualTypeOf<import('./executionRuns.js').ExecutionRunConnectedServicesCleanupReceiptV1>();
    expectTypeOf<PublicDaemonExecutionRunMarkerOwnerWrite>()
      .toEqualTypeOf<import('./executionRuns.js').DaemonExecutionRunMarkerOwnerWrite>();
  });
  it('retains only an exact privacy-bounded cleanup receipt at the owner write boundary', () => {
    const marker = {
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_cleanup',
      callId: 'call_cleanup',
      sidechainId: 'side_cleanup',
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'codex' },
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 1,
      updatedAtMs: 2,
      finishedAtMs: 2,
      executionRunConnectedServicesCleanupReceiptV1: {
        v: 1,
        activationId: '66666666-6666-4666-8666-666666666666',
        runKey: 'run_cleanup',
        agentId: 'codex',
      },
    };

    expect(DaemonExecutionRunMarkerOwnerWriteSchema.parse(marker))
      .toHaveProperty('executionRunConnectedServicesCleanupReceiptV1');
    expect(DaemonExecutionRunMarkerSchema.parse(marker))
      .not.toHaveProperty('executionRunConnectedServicesCleanupReceiptV1');
    expect(DaemonExecutionRunMarkerOwnerWriteSchema.safeParse({
      ...marker,
      executionRunConnectedServicesCleanupReceiptV1: {
        ...marker.executionRunConnectedServicesCleanupReceiptV1,
        runKey: 'another-run',
      },
    }).success).toBe(false);
  });

  it('accepts an explicit detached execution-run marker without inventing a Session id', () => {
    const parsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: null,
      runId: 'run_detached_1',
      callId: 'call_detached_1',
      sidechainId: 'side_detached_1',
      intent: 'memory_hints',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      status: 'running',
      startedAtMs: 0,
      updatedAtMs: 1,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.happySessionId).toBeNull();
  });

  it('keeps bounded public execution-run facts while stripping private marker payloads', () => {
    const parsed = DaemonExecutionRunMarkerSchema.parse({
      happyHomeDir: '/private/happy-home',
      pid: 123,
      happySessionId: null,
      runId: 'run_terminal_1',
      callId: 'call_terminal_1',
      sidechainId: 'side_terminal_1',
      intent: 'memory_hints',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        configuredBackendId: 'private-configured-target',
        sourceKind: 'configured',
      },
      display: { title: 'private prompt-derived label' },
      permissionMode: 'full_access',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      status: 'failed',
      startedAtMs: 0,
      updatedAtMs: 2,
      finishedAtMs: 2,
      errorCode: 'execution_run_output_limit_exceeded',
      resultSizeBytes: 1024,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        providerSessionId: 'private-provider-session',
      },
      summary: 'unbounded output summary must not reach the marker',
      diagnostics: { livenessProbe: { rawOutput: 'must-not-persist' } },
      arbitraryProducerField: 'must-not-persist',
    });

    expect(parsed).toEqual({
      pid: 123,
      happySessionId: null,
      runId: 'run_terminal_1',
      callId: 'call_terminal_1',
      sidechainId: 'side_terminal_1',
      intent: 'memory_hints',
      backendTarget: { kind: 'backend', backendId: 'codex' },
      permissionMode: 'full_access',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      status: 'failed',
      startedAtMs: 0,
      updatedAtMs: 2,
      finishedAtMs: 2,
      errorCode: 'execution_run_output_limit_exceeded',
      resultSizeBytes: 1024,
    });
    expect(JSON.stringify(parsed)).not.toContain('/private/happy-home');
    expect(JSON.stringify(parsed)).not.toContain('private-configured-target');
    expect(JSON.stringify(parsed)).not.toContain('private prompt-derived label');
    expect(JSON.stringify(parsed)).not.toContain('private-provider-session');
  });

  it('drops connected-services launch configuration from canonical marker writes', () => {
    const parsed = DaemonExecutionRunMarkerSchema.parse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_marker_privacy',
      callId: 'call_marker_privacy',
      sidechainId: 'side_marker_privacy',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'running',
      startedAtMs: 0,
      updatedAtMs: 1,
      executionRunConnectedServicesLaunchV1: {
        v: 1,
        runKey: 'run_marker_privacy',
        agentId: 'codex',
        materializationKey: 'run_marker_privacy',
        connectedServicesBindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'private-profile' },
          },
        },
        connectedServiceSelectionsEnv: {
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'private-profile',
          }]),
        },
        sessionDirectory: '/private/workspace',
        materializedRoot: '/private/materialized',
      },
    });

    expect(parsed).not.toHaveProperty('executionRunConnectedServicesLaunchV1');
    expect(JSON.stringify(parsed)).not.toContain('/private/workspace');
    expect(JSON.stringify(parsed)).not.toContain('private-profile');
  });

  it('accepts and normalizes the exact remote-dev persisted launch shape only on the compatibility read path', () => {
    const connectedServiceSelectionsJson = JSON.stringify([{
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: 'team',
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    }]);
    const parsed = DaemonExecutionRunMarkerPersistenceReadSchema.parse({
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
            'happier.agent.codex/openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'team',
            },
          },
        },
        connectedServiceSelectionsEnv: {
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
            kind: 'profile',
            serviceId: 'happier.agent.codex/openai-codex',
            profileId: 'team',
            credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
          }]),
        },
        sessionDirectory: '/workspace',
        materializedRoot: '/managed/materialized/execution_run_one',
      },
    });
    expect(parsed.executionRunConnectedServicesLaunchV1).not.toHaveProperty('materializationKey');
    expect(parsed.executionRunConnectedServicesLaunchV1).not.toHaveProperty('connectedServiceSelectionsEnv');
    expect(DaemonExecutionRunMarkerPersistenceReadSchema.safeParse({
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
    expect(DaemonExecutionRunMarkerPersistenceReadSchema.safeParse({
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

  it('accepts a strict legacy launch fact only on the compatibility read path', () => {
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
    const parsed = DaemonExecutionRunMarkerPersistenceReadSchema.parse({
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

    expect(parsed.executionRunConnectedServicesLaunchV1).toEqual({
      ...launch,
      connectedServicesBindings: {
        v: 1,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'profile_1',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
          kind: 'profile',
          serviceId: 'happier.agent.codex/openai-codex',
          profileId: 'profile_1',
        }]),
      },
    });
    expect(normalizePersistedExecutionRunConnectedServicesLaunchV1(
      parsed.executionRunConnectedServicesLaunchV1,
    )).toMatchObject({
      source: 'current',
      registration: {
        connectedServicesBindings: {
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': expect.any(Object),
          },
        },
      },
    });
    expect(DaemonExecutionRunMarkerPersistenceReadSchema.safeParse({
      ...parsed,
      executionRunConnectedServicesLaunchV1: {
        ...launch,
        activationId: 'pid-only-is-not-authority',
      },
    }).success).toBe(false);

    expect(DaemonExecutionRunMarkerPersistenceReadSchema.safeParse({
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
    expect(DaemonExecutionRunMarkerPersistenceReadSchema.safeParse({
      ...parsed,
      executionRunConnectedServicesLaunchV1: { ...launch, credential: 'must-not-persist' },
    }).success).toBe(false);
    expect(DaemonExecutionRunMarkerPersistenceReadSchema.safeParse({
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
    expect(DaemonExecutionRunMarkerPersistenceReadSchema.safeParse({
      ...parsed,
      executionRunConnectedServicesLaunchV1: {
        ...launch,
        connectedServiceSelectionsEnv: {
          ...launch.connectedServiceSelectionsEnv,
          OPENAI_API_KEY: 'must-not-persist',
        },
      },
    }).success).toBe(false);
    expect(DaemonExecutionRunMarkerPersistenceReadSchema.safeParse({
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
  it('drops provider resume handles from canonical marker bytes', () => {
    const parsed = DaemonExecutionRunMarkerSchema.parse({
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

    expect(parsed).not.toHaveProperty('resumeHandle');
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
    });
    expect((parsed.runs[0] as any).extraTransportField).toBe('keep-me');
  });

  it('reduces legacy backendId marker input to bounded backend identity', () => {
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
    expect(parsed.data.backendTarget).toEqual({ kind: 'backend', backendId: 'codex' });
    expect(parsed.data).not.toHaveProperty('resumeHandle');
  });

  it('drops legacy configured backend provenance and resume configuration from markers', () => {
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
    });
    expect(parsed.data).not.toHaveProperty('resumeHandle');
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
