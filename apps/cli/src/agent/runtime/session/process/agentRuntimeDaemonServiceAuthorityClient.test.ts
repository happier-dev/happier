import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { hashProcessCommand } from '@/daemon/sessionRegistry';
import {
  createAgentRuntimeDaemonServiceAuthorityPath,
  publishAgentRuntimeDaemonServiceAuthority,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
  admitCurrentRunnerSessionInput,
  dispatchCurrentAgentRuntimeDaemonServiceRequest,
  dispatchCurrentRunnerDaemonPluginService,
  attestCurrentRunnerAgentSessionOpen,
  isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition,
  RUNNER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_TRANSITION_CODE,
  resolveCurrentAgentRuntimeDaemonTurnContributions,
} from './agentRuntimeDaemonServiceAuthorityClient';

const roots: string[] = [];
const processIdentityMock = vi.hoisted(() => vi.fn());
const runnerIdentityMock = vi.hoisted(() => vi.fn());

vi.mock('@/daemon/processIdentity', () => ({
  readProcessIdentityByPid: processIdentityMock,
}));
vi.mock(
  '@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity',
  () => ({
    resolveSessionRunnerEntrypointIdentityFromProcessCommand:
      runnerIdentityMock,
  }),
);

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

async function createTestAuthority(input: Readonly<{
  happyHomeDir: string;
  runner: Readonly<{
    pid: number;
    processStartTimeMs: number;
    processCommandHash: string;
    snapshotIdentity: string;
  }>;
}>): Promise<Readonly<{
  path: string;
  happyHomeDir: string;
  publicReleaseRing: 'stable';
  sessionId: string;
  runner: typeof input.runner;
  retainedAgent: ReturnType<typeof createAgentSessionRunnerFactoryBinding>;
}>> {
  return {
    path: await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir: input.happyHomeDir,
      publicReleaseRing: 'stable',
    }),
    happyHomeDir: input.happyHomeDir,
    publicReleaseRing: 'stable',
    sessionId: 'session-1',
    runner: input.runner,
    retainedAgent: createAgentSessionRunnerFactoryBinding({
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
    }),
  };
}

describe('current Agent runtime daemon service authority client', () => {
  it('preserves durable Session admission truth and classifies a lost daemon response as outcome unknown', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-agent-input-admission-'),
    );
    roots.push(happyHomeDir);
    const command = 'happier runner';
    const runner = {
      pid: process.pid,
      processStartTimeMs: 1_717_171_717_000,
      processCommandHash: hashProcessCommand(command),
      snapshotIdentity: 'snapshot:runner-a',
    };
    processIdentityMock.mockResolvedValue({
      pid: process.pid,
      processStartTimeMs: runner.processStartTimeMs,
      command,
    });
    runnerIdentityMock.mockReturnValue({
      status: 'known',
      comparableId: runner.snapshotIdentity,
    });
    const authority = await createTestAuthority({ happyHomeDir, runner });
    await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: {
          kind: 'session.input.admission',
          status: 'resolved',
          admission: { status: 'alreadyAccepted', localId: 'local-1' },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockRejectedValueOnce(new TypeError('daemon response lost after dispatch'));
    vi.stubGlobal('fetch', fetchMock);
    const request = {
      v: 1 as const,
      sessionId: 'session-1',
      targetMachineId: 'machine-1',
      localId: 'local-1',
      content: { t: 'plain' as const, v: { role: 'user' as const } },
      requestedAction: { v: 1 as const, kind: 'enqueue' as const },
    };

    await expect(admitCurrentRunnerSessionInput({
      authority,
      requestId: 'admission-accepted',
      request,
      timeoutMs: null,
    })).resolves.toEqual({ status: 'alreadyAccepted', localId: 'local-1' });
    await expect(admitCurrentRunnerSessionInput({
      authority,
      requestId: 'admission-unknown',
      request,
      timeoutMs: null,
    })).resolves.toEqual({
      status: 'outcomeUnknown',
      localId: 'local-1',
      code: 'machine_admission_daemon_response_unknown',
    });

    const cancellation = new AbortController();
    cancellation.abort();
    await expect(admitCurrentRunnerSessionInput({
      authority,
      requestId: 'admission-cancelled',
      request,
      timeoutMs: null,
      signal: cancellation.signal,
    })).resolves.toEqual({
      status: 'rejected',
      code: 'session_input_cancelled',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves daemon-settled service errors while only the pre-service invocation miss enables safe reprepare', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-agent-service-client-'),
    );
    roots.push(happyHomeDir);
    const runner = {
      pid: 1234,
      processStartTimeMs: 1_717_171_717_000,
      processCommandHash: 'a'.repeat(64),
      snapshotIdentity: 'snapshot:runner-a',
    };
    const authority = await createTestAuthority({ happyHomeDir, runner });
    await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        ok: false,
        error: {
          code: 'plugin_services_invocation_unavailable',
          message: 'Runner PluginServices invocation is unavailable',
        },
      }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })));

    await expect(dispatchCurrentRunnerDaemonPluginService({
      authority,
      timeoutMs: null,
      operation: {
        kind: 'plugin_storage.set_v1',
        requestId: 'request-1',
        invocationId: 'invocation-1',
        scope: 'daemonSession',
        key: 'key',
        value: { t: 'string', value: 'value' },
      },
    })).rejects.toMatchObject({
      code: 'plugin_services_invocation_unavailable',
    });

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        ok: false,
        error: {
          code: 'plugin_settings_revision_conflict',
          message: 'Plugin settings revision conflicts',
        },
      }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })));
    await expect(dispatchCurrentRunnerDaemonPluginService({
      authority,
      timeoutMs: null,
      operation: {
        kind: 'plugin_settings.set_v1',
        requestId: 'request-2',
        invocationId: 'invocation-1',
        scope: 'daemon',
        id: 'setting',
        value: { t: 'string', value: 'value' },
        expectedRevision: 'revision-1',
      },
    })).rejects.toMatchObject({
      code: 'plugin_settings_revision_conflict',
    });
  });

  it('recognizes only the narrow proven authority-transition error', () => {
    expect(
      isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition(
        Object.assign(new Error('rotated'), {
          code:
            RUNNER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_TRANSITION_CODE,
        }),
      ),
    ).toBe(true);
    expect(
      isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition(
        Object.assign(new Error('unavailable'), {
          code:
            'native_agent_privileged_effect_authority_unavailable',
        }),
      ),
    ).toBe(false);
    expect(
      isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition({
        code:
          RUNNER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_TRANSITION_CODE,
      }),
    ).toBe(false);
  });

  it('retries exact session-open attestation once across proven daemon rotation', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-agent-read-rotation-'),
    );
    roots.push(happyHomeDir);
    const command = 'happier runner';
    const runner = {
      pid: process.pid,
      processStartTimeMs: 1_717_171_717_000,
      processCommandHash: hashProcessCommand(command),
      snapshotIdentity: 'snapshot:runner-a',
    };
    processIdentityMock.mockResolvedValue({
      pid: process.pid,
      processStartTimeMs: runner.processStartTimeMs,
      command,
    });
    runnerIdentityMock.mockReturnValue({
      status: 'known',
      comparableId: runner.snapshotIdentity,
    });
    const authority = await createTestAuthority({ happyHomeDir, runner });
    await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });
    const operations: unknown[] = [];
    const fetchMock = vi.fn(async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      operations.push(
        JSON.parse(String(init?.body)).operation,
      );
      const attempt = operations.length;
      if (attempt === 1) {
        await publishAgentRuntimeDaemonServiceAuthority({
          ...authority,
          httpPort: 31_000 + attempt + 1,
          capability:
            'B'.repeat(43),
        });
        return new Response(null, { status: 503 });
      }
      return new Response(JSON.stringify({
        ok: true,
        result: {
          kind: 'session.open.attestation',
          status: 'recorded',
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(attestCurrentRunnerAgentSessionOpen({
      authority,
      requestId: 'attest-1',
      request: {
        kind: 'create',
        sessionId: 'session-1',
        cwd: '/workspace',
        stateSharing: {
          configMode: 'isolated',
          stateMode: 'isolated',
        },
      },
      providerSessionId: 'provider-1',
      timeoutMs: null,
    })).resolves.toMatchObject({ status: 'recorded' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(operations).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({
          stateSharing: {
            configMode: 'isolated',
            stateMode: 'isolated',
          },
        }),
      }),
      expect.objectContaining({
        request: expect.objectContaining({
          stateSharing: {
            configMode: 'isolated',
            stateMode: 'isolated',
          },
        }),
      }),
    ]);
  });

  it('hardened-rereads the atomic endpoint/capability pair once per operation without resending', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-agent-service-client-'),
    );
    roots.push(happyHomeDir);
    const runner = {
      pid: 1234,
      processStartTimeMs: 1_717_171_717_000,
      processCommandHash: 'a'.repeat(64),
      snapshotIdentity: 'snapshot:runner-a',
    };
    const authority = await createTestAuthority({ happyHomeDir, runner });
    await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });

    const observations: Array<Readonly<{
      endpoint: string;
      header: string | undefined;
      bodyToken: string;
    }>> = [];
    const fetchMock = vi.fn(async (
      url: string | URL | Request,
      options?: RequestInit,
    ) => {
      const body = JSON.parse(String(options?.body));
      observations.push({
        endpoint: String(url),
        header: (options?.headers as Record<string, string>)[
          'x-happier-daemon-token'
        ],
        bodyToken: body.context.token,
      });
      return new Response(JSON.stringify({
        ok: true,
        result: {
          kind: 'turn.admission',
          status: 'admitted',
          witness: body.operation.witness,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const dispatch = async () =>
      await dispatchCurrentAgentRuntimeDaemonServiceRequest({
        authority,
        timeoutMs: null,
        createRequest: (capability) => ({
          v: 1,
          context: {
            token: capability,
            sessionId: 'session-1',
          },
          operation: {
            kind: 'turn.admission.authorize',
            requestId: randomRequestId(),
            witness: {
              turnId: 'turn-1',
              inputId: 'input-1',
              userMessageSeq: 7,
              userMessageSeqs: [7],
            },
          },
        }),
      });

    await expect(dispatch()).resolves.toMatchObject({
      ok: true,
      result: {
        kind: 'turn.admission',
        status: 'admitted',
      },
    });
    await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_002,
      capability: 'B'.repeat(43),
    });
    await expect(dispatch()).resolves.toMatchObject({
      ok: true,
      result: {
        kind: 'turn.admission',
        status: 'admitted',
      },
    });
    expect(observations).toEqual([
      {
        endpoint:
          'http://127.0.0.1:31001/agent-runtime/session/services/v1',
        header: 'A'.repeat(43),
        bodyToken: 'A'.repeat(43),
      },
      {
        endpoint:
          'http://127.0.0.1:31002/agent-runtime/session/services/v1',
        header: 'B'.repeat(43),
        bodyToken: 'B'.repeat(43),
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a dead stale endpoint before connect from an accepted request with a lost response', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-agent-service-client-'),
    );
    roots.push(happyHomeDir);
    const runner = {
      pid: 1234,
      processStartTimeMs: 1_717_171_717_000,
      processCommandHash: 'a'.repeat(64),
      snapshotIdentity: 'snapshot:runner-a',
    };
    const authority = await createTestAuthority({ happyHomeDir, runner });
    await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(
        new Error('connect refused'),
        { code: 'ECONNREFUSED' },
      ),
    });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(
        new TypeError(
          'connection closed after request acceptance',
        ),
      )
      .mockRejectedValueOnce(
        new TypeError(
          'connection closed while resolving pre-admission contributions',
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const dispatch = async () =>
      await dispatchCurrentAgentRuntimeDaemonServiceRequest({
        authority,
        timeoutMs: null,
        createRequest: (capability) => ({
          v: 1,
          context: {
            token: capability,
            sessionId: 'session-1',
          },
          operation: {
            kind: 'turn.admission.authorize',
            requestId: 'cancel-ambiguous',
            witness: {
              turnId: 'turn-1',
              inputId: 'input-1',
              userMessageSeq: 7,
              userMessageSeqs: [7],
            },
          },
        }),
      });
    await expect(dispatch()).resolves.toEqual({
      ok: false,
      error: {
        code: 'native_agent_privileged_effect_authority_unavailable',
        message:
          'Native Agent privileged effect authority is unavailable before dispatch',
      },
    });
    await expect(dispatch()).resolves.toEqual({
      ok: false,
      error: {
        code: 'native_agent_privileged_effect_outcome_unknown',
        message:
          'Native Agent privileged effect outcome is unknown after dispatch',
      },
    });
    await expect(
      resolveCurrentAgentRuntimeDaemonTurnContributions({
        authority,
        requestId: 'contributions-before-admission',
        timeoutMs: null,
        request: {
          kind: 'transformSessionInput',
          payload: { input: 'hello' },
        },
      }),
    ).rejects.toMatchObject({
      kind: 'authority_unavailable_before_effect',
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('classifies a daemon-settled post-dispatch custody 503 as outcome unknown and keeps a quiescing 503 a proven pre-dispatch miss', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-agent-service-client-'),
    );
    roots.push(happyHomeDir);
    const command = 'happier runner';
    const runner = {
      pid: process.pid,
      processStartTimeMs: 1_717_171_717_000,
      processCommandHash: hashProcessCommand(command),
      snapshotIdentity: 'snapshot:runner-a',
    };
    processIdentityMock.mockResolvedValue({
      pid: process.pid,
      processStartTimeMs: runner.processStartTimeMs,
      command,
    });
    runnerIdentityMock.mockReturnValue({
      status: 'known',
      comparableId: runner.snapshotIdentity,
    });
    const authority = await createTestAuthority({ happyHomeDir, runner });
    await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });
    const custody503 = () => new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'agent_runtime_daemon_service_admission_custody_unavailable',
        message:
          'Agent runtime daemon service admission custody is unavailable',
      },
    }), { status: 503 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(custody503())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error: {
          code: 'agent_runtime_daemon_service_unavailable',
          message: 'Agent runtime daemon service is unavailable',
        },
      }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        errorCode: 'daemon_shutting_down',
      }), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const dispatch = (requestId: string) =>
      dispatchCurrentAgentRuntimeDaemonServiceRequest({
        authority,
        timeoutMs: null,
        createRequest: (capability) => ({
          v: 1,
          context: {
            token: capability,
            sessionId: 'session-1',
          },
          operation: {
            kind: 'turn.admission.authorize',
            requestId,
            witness: {
              turnId: 'turn-1',
              inputId: 'input-1',
              userMessageSeq: 7,
              userMessageSeqs: [7],
            },
          },
        }),
      });

    // The daemon settled the request after dispatch: the admission custody
    // effect may already have been recorded, so the closed typed outcome is
    // unknown — never "unavailable before dispatch".
    await expect(dispatch('custody-503')).resolves.toEqual({
      ok: false,
      error: {
        code: 'native_agent_privileged_effect_outcome_unknown',
        message:
          'Native Agent privileged effect outcome is unknown after dispatch',
      },
    });
    // A merely typed 503 is not evidence that dispatch occurred.
    await expect(dispatch('typed-predispatch-503')).resolves.toEqual({
      ok: false,
      error: {
        code: 'native_agent_privileged_effect_authority_unavailable',
        message:
          'Native Agent privileged effect authority is unavailable before dispatch',
      },
    });
    // The route refused before dispatch while quiescing: not attempted.
    await expect(dispatch('quiescing-503')).resolves.toEqual({
      ok: false,
      error: {
        code: 'native_agent_privileged_effect_authority_unavailable',
        message:
          'Native Agent privileged effect authority is unavailable before dispatch',
      },
    });

    // The effectful Plugin Services client owner consumes the same closed
    // distinction: a settled custody 503 is outcome unknown (never replayed),
    // not a safe pre-service miss.
    vi.stubGlobal('fetch', vi.fn(async () => custody503()));
    await expect(dispatchCurrentRunnerDaemonPluginService({
      authority,
      timeoutMs: null,
      operation: {
        kind: 'plugin_storage.set_v1',
        requestId: 'request-custody-503',
        invocationId: 'invocation-1',
        scope: 'daemonSession',
        key: 'key',
        value: { t: 'string', value: 'value' },
      },
    })).rejects.toMatchObject({
      kind: 'outcome_unknown_after_dispatch',
      retryable: false,
    });
  });
});

let requestSequence = 0;
function randomRequestId(): string {
  requestSequence += 1;
  return `request-${requestSequence}`;
}
