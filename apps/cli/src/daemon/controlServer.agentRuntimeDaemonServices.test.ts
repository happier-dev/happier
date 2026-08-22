import { describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import {
  AGENT_RUNTIME_DAEMON_SERVICES_PATH,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import {
  createAgentSessionRunnerFactoryBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createDaemonControlApp } from './controlServer';
import {
  createAgentRuntimeDaemonServiceAuthorityPath,
  hashAgentRuntimeSessionBridgeToken,
  publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned,
} from './agentRuntime/sessionBridgeAuthorization';
import type { TrackedSession } from './types';
import { clearTrackedRunnerAgentDaemonServiceAdmission } from './agentRuntime/clearTrackedRunnerAgentDaemonServiceAdmission';

type RecordAdmission = NonNullable<
  Parameters<typeof createDaemonControlApp>[0][
    'recordAgentRuntimeDaemonServiceAdmission'
  ]
>;
type RecordedAdmission = Parameters<RecordAdmission>[1];

const capabilityA = 'A'.repeat(43);
const capabilityB = 'B'.repeat(43);

function createRetainedAgent() {
  return createAgentSessionRunnerFactoryBinding({
    v: 1,
    pluginId: 'acme.plugin',
    pluginVersion: '1.2.3',
    agentId: 'acme-agent',
    localAgentId: 'acme-agent',
    immutableGenerationId: `sha256:${'1'.repeat(64)}`,
    locator: {
      module: './runtime.mjs',
      export: 'createRuntime',
      runtimeApiVersion: 1,
    },
    normalizedModulePath: '/immutable/acme/runtime.mjs',
    loadMode: 'immutable-js',
  });
}

describe('daemon control server: runner-scoped Agent runtime services', () => {
  it('authorizes direct retained-runner custody with a rotated capability and exact turn witness', async () => {
    const sessionId = 'session-1';
    const retainedAgent = createRetainedAgent();
    const runner = {
      pid: 1234,
      processStartTimeMs: 1_717_171_717_000,
      processCommandHash: 'a'.repeat(64),
      snapshotIdentity: 'snapshot:runner-a',
    };
    const authorityPath =
      await createAgentRuntimeDaemonServiceAuthorityPath({
        happyHomeDir: configuration.happyHomeDir,
        publicReleaseRing: configuration.publicReleaseRing,
      });
    const publishAuthority = async (capability: string) =>
      await publishAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: configuration.happyHomeDir,
        publicReleaseRing: configuration.publicReleaseRing,
        path: authorityPath,
        sessionId,
        runner,
        retainedAgent,
        httpPort: 46_001,
        capability,
        readPluginHardRevocationRevision: async () => 0,
      });
    let authority = await publishAuthority(capabilityA);
    const invocationContext = Object.freeze({
      cwd: '/workspace',
      environment: Object.freeze({}),
      providerBindingActive: false,
    });
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: runner.pid,
      sessionRunnerPid: runner.pid,
      happySessionId: sessionId,
      processStartTimeMs: runner.processStartTimeMs,
      processCommandHash: runner.processCommandHash,
      agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
      agentRuntimeDaemonServiceCapabilityHash:
        authority.capabilityDigest,
      runnerAgentImmutableGenerationId:
        retainedAgent.immutableGenerationId,
      runnerAgentInvocationContext: invocationContext,
    };
    const dispatch = vi.fn(async (
      request: { operation: { kind: string } },
      _context: unknown,
    ) => request.operation.kind === 'turn.admission.authorize'
      ? {
          ok: true as const,
          result: {
            kind: 'turn.admission' as const,
            status: 'admitted' as const,
            witness: {
              turnId: 'turn-1',
              inputId: 'input-1',
              userMessageSeq: 7,
              userMessageSeqs: [7],
            },
          },
        }
      : request.operation.kind === 'session.open.attest'
        ? {
            ok: true as const,
            result: {
              kind: 'session.open.attestation' as const,
              status: 'recorded' as const,
            },
          }
        : {
            ok: true as const,
            result: {
              kind: 'managed_server.endpoint' as const,
              status: 'unavailable' as const,
            },
          });
    const authorizeForegroundDaemonServiceRequest = vi.fn(() => null);
    const recordAdmission = vi.fn<RecordAdmission>(async () => true);
    const clearAdmission = vi.fn<NonNullable<
      Parameters<typeof createDaemonControlApp>[0][
        'clearAgentRuntimeDaemonServiceAdmission'
      ]
    >>(async () => true);
    const app = createDaemonControlApp({
      getChildren: () => [tracked],
      machineId: 'machine-1',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'control-token',
      agentRuntimeDaemonServices: { dispatch },
      foregroundAgentRuntimeAdmission: {
        authorizeDaemonServiceRequest:
          authorizeForegroundDaemonServiceRequest,
      } as never,
      recordAgentRuntimeDaemonServiceAdmission:
        recordAdmission,
      clearAgentRuntimeDaemonServiceAdmission:
        clearAdmission,
    });
    const send = async (header: string, token = header) =>
      await app.inject({
        method: 'POST',
        url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
        headers: { 'x-happier-daemon-token': header },
        payload: {
          v: 1,
          context: {
            token,
            sessionId,
          },
          operation: {
            kind: 'turn.admission.authorize',
            requestId: 'request-1',
            witness: {
              turnId: 'turn-1',
              inputId: 'input-1',
              userMessageSeq: 7,
              userMessageSeqs: [7],
            },
          },
        },
      });
    const resolveEndpoint = async (
      inputId: string,
      token = capabilityB,
    ) =>
      await app.inject({
        method: 'POST',
        url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
        headers: {
          'x-happier-daemon-token': token,
        },
        payload: {
          v: 1,
          context: {
            token,
            sessionId,
          },
          operation: {
            kind: 'managed_server.endpoint.resolve',
            requestId: 'resolve-1',
            witness: {
              turnId: 'turn-1',
              inputId,
              userMessageSeq: 7,
              userMessageSeqs: [7],
            },
            selector: {
              kind: 'projectionToken',
              projectionToken: 'b'.repeat(64),
            },
          },
        },
      });
    const attestSessionOpen = async () =>
      await app.inject({
        method: 'POST',
        url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
        headers: {
          'x-happier-daemon-token': capabilityB,
        },
        payload: {
          v: 1,
          context: {
            token: capabilityB,
            sessionId,
          },
          operation: {
            kind: 'session.open.attest',
            requestId: 'attest-open-1',
            request: {
              kind: 'resume',
              sessionId,
              cwd: '/workspace',
              providerSessionId: 'provider-1',
            },
            providerSessionId: 'provider-1',
          },
        },
      });

    try {
      await app.ready();
      Object.assign(tracked, {
        activeTurnId: 'turn-1',
        reattachedInterruptedTurnId: 'turn-1',
      });
      expect(
        (await resolveEndpoint('input-1', capabilityA)).statusCode,
      ).toBe(403);
      delete (tracked as { activeTurnId?: string }).activeTurnId;
      delete (tracked as { reattachedInterruptedTurnId?: string })
        .reattachedInterruptedTurnId;

      expect((await send('control-token', capabilityA)).statusCode)
        .toBe(403);
      expect((await send(capabilityB)).statusCode).toBe(403);
      expect(authorizeForegroundDaemonServiceRequest)
        .not.toHaveBeenCalled();

      expect((await send(capabilityA)).statusCode).toBe(200);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: expect.objectContaining({
            witness: {
              turnId: 'turn-1',
              inputId: 'input-1',
              userMessageSeq: 7,
              userMessageSeqs: [7],
            },
          }),
        }),
        expect.objectContaining({
          sessionId,
          runner,
          retainedAgent,
          invocationContext,
          trackedSession: tracked,
        }),
      );
      expect(Object.keys(dispatch.mock.calls[0]?.[1] ?? {}).sort())
        .toEqual([
          'invocationContext',
          'retainedAgent',
          'runner',
          'sessionId',
          'signal',
          'trackedSession',
        ]);

      authority = await publishAuthority(capabilityB);
      // The private authority document rotated before tracked custody did, so
      // neither the stale capability nor the not-yet-projected replacement can
      // reach dispatch during that handoff window.
      expect((await send(capabilityA)).statusCode).toBe(403);
      expect((await send(capabilityB)).statusCode).toBe(403);
      expect(dispatch).toHaveBeenCalledTimes(1);
      tracked.agentRuntimeDaemonServiceCapabilityHash =
        authority.capabilityDigest;
      expect((await send(capabilityA)).statusCode).toBe(403);
      expect((await send(capabilityB)).statusCode).toBe(200);
      expect((await attestSessionOpen()).statusCode).toBe(200);
      expect(dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          operation: expect.objectContaining({
            kind: 'session.open.attest',
          }),
        }),
        expect.objectContaining({
          sessionId,
          runner,
          retainedAgent,
          invocationContext,
          trackedSession: tracked,
        }),
      );

      expect(
        (await resolveEndpoint('foreign-input')).statusCode,
      ).toBe(403);
      tracked.runnerAgentImmutableGenerationId =
        'forged-generation';
      expect(
        (await resolveEndpoint('input-1')).statusCode,
      ).toBe(403);
      tracked.runnerAgentImmutableGenerationId =
        retainedAgent.immutableGenerationId;
      tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs = [8];
      expect(
        (await resolveEndpoint('input-1')).statusCode,
      ).toBe(403);
      tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs = [7];
      expect(
        (await resolveEndpoint('input-1')).statusCode,
      ).toBe(200);

      let markerAdmission: RecordedAdmission | null = null;
      let resolveRecordEntered: (() => void) | undefined;
      const recordEntered = new Promise<void>((resolve) => {
        resolveRecordEntered = resolve;
      });
      let resumeRecord: (() => void) | undefined;
      const recordGate = new Promise<void>((resolve) => {
        resumeRecord = resolve;
      });
      recordAdmission.mockImplementationOnce(
        async (_tracked, admission) => {
          resolveRecordEntered?.();
          await recordGate;
          markerAdmission = admission;
          return true;
        },
      );
      clearAdmission.mockImplementationOnce(
        async (_tracked, admission) => {
          if (
            markerAdmission
            && JSON.stringify(markerAdmission)
              === JSON.stringify(admission)
          ) {
            markerAdmission = null;
          }
          return true;
        },
      );

      const racedAdmission = send(capabilityB);
      await recordEntered;

      // Mirror the existing synchronous hard-revocation mutation while its
      // marker cleanup and runner termination continue asynchronously.
      tracked.agentRuntimeRunnerRestartDisposition =
        'runner_authority_unavailable';
      delete tracked.agentRuntimeDaemonServiceCapabilityHash;
      clearTrackedRunnerAgentDaemonServiceAdmission(tracked);

      resumeRecord?.();
      const racedResponse = await racedAdmission;
      expect(racedResponse.statusCode).toBe(503);
      expect(racedResponse.json()).toEqual({
        ok: false,
        error: {
          code:
            'agent_runtime_daemon_service_admission_custody_unavailable',
          message:
            'Agent runtime daemon service admission custody is unavailable',
        },
      });
      expect(markerAdmission).toBeNull();
      expect(clearAdmission).toHaveBeenCalledWith(
        tracked,
        {
          turnId: 'turn-1',
          inputId: 'input-1',
          userMessageSeq: 7,
          userMessageSeqs: [7],
        },
      );
      expect(tracked.agentRuntimeDaemonServiceAdmittedTurnId)
        .toBeUndefined();
      expect(tracked.agentRuntimeDaemonServiceAdmittedInputId)
        .toBeUndefined();

      const dispatchCountAfterRevocation = dispatch.mock.calls.length;
      expect((await send(capabilityB)).statusCode).toBe(403);
      expect(dispatch).toHaveBeenCalledTimes(
        dispatchCountAfterRevocation,
      );
    } finally {
      await app.close();
      await removeAgentRuntimeDaemonServiceAuthorityIfOwned({
        happyHomeDir: configuration.happyHomeDir,
        publicReleaseRing: configuration.publicReleaseRing,
        path: authorityPath,
        capabilityDigest: authority.capabilityDigest,
      });
    }
  });

  it('uses the foreground owner as the exact direct-custody and admission subject after V2 claim', async () => {
    const sessionId = 'session-foreground';
    const retainedAgent = createRetainedAgent();
    const runner = {
      pid: 4321,
      processStartTimeMs: 1_717_171_717_000,
      processCommandHash: 'a'.repeat(64),
      snapshotIdentity: 'snapshot:foreground',
    };
    const invocationContext = Object.freeze({
      cwd: '/workspace',
      environment: Object.freeze({}),
      providerBindingActive: false,
    });
    let admission: RecordedAdmission | null = null;
    const recordAdmission = vi.fn(async (next: RecordedAdmission) => {
      admission = next;
      return true;
    });
    const authorizeDaemonServiceRequest = vi.fn(
      ({ providedCapability }: { providedCapability: string }) =>
        providedCapability === 'F'.repeat(43)
          ? {
              retainedAgent,
              runner,
              capabilityDigest:
                hashAgentRuntimeSessionBridgeToken('F'.repeat(43)),
              invocationContext,
              readAdmission: () => admission,
              recordAdmission,
            }
          : null,
    );
    const dispatch = vi.fn(async (
      _request: unknown,
      _context: unknown,
    ) => ({
      ok: true as const,
      result: {
        kind: 'turn.admission' as const,
        status: 'admitted' as const,
        witness: {
          turnId: 'turn-foreground',
          inputId: 'input-foreground',
          userMessageSeq: 9,
          userMessageSeqs: [9],
        },
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine-1',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'success',
        sessionId: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'control-token',
      agentRuntimeDaemonServices: { dispatch },
      foregroundAgentRuntimeAdmission: {
        authorizeDaemonServiceRequest,
      } as never,
    });

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
        headers: {
          'x-happier-daemon-token': 'F'.repeat(43),
        },
        payload: {
          v: 1,
          context: {
            token: 'F'.repeat(43),
            sessionId,
          },
          operation: {
            kind: 'turn.admission.authorize',
            requestId: 'request-foreground',
            witness: {
              turnId: 'turn-foreground',
              inputId: 'input-foreground',
              userMessageSeq: 9,
              userMessageSeqs: [9],
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(authorizeDaemonServiceRequest)
        .toHaveBeenCalledOnce();
      expect(recordAdmission).toHaveBeenCalledWith({
        turnId: 'turn-foreground',
        inputId: 'input-foreground',
        userMessageSeq: 9,
        userMessageSeqs: [9],
      });
      expect(dispatch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sessionId,
          runner,
          retainedAgent,
          invocationContext,
        }),
      );
      expect(Object.keys(dispatch.mock.calls[0]?.[1] ?? {}).sort())
        .toEqual([
          'invocationContext',
          'retainedAgent',
          'runner',
          'sessionId',
          'signal',
        ]);
    } finally {
      await app.close();
    }
  });
});
