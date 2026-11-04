import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol';
import { createAgentRuntimeDaemonServiceAuthorityFixture as createTestAuthority } from './agentRuntimeDaemonServiceAuthority.testkit';

import { hashProcessCommand } from '@/daemon/sessionRegistry';
import {
  publishAgentRuntimeDaemonServiceAuthority,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { sanitizeNativeAgentSessionBoundaryError } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { logger } from '@/ui/logger';
import * as privateBearerFile from '@/daemon/privateBearerFile';
import { prepareRunnerDaemonPluginServices } from './runnerDaemonPluginServices';
import { encodeRunnerDaemonPluginServiceWireValueV1 } from './agentRuntimeDaemonPluginServicesProtocol';
import {
  admitCurrentRunnerSessionInput,
  authorizeCurrentAgentRuntimeDaemonModelTransition,
  closeCurrentRunnerTeamCredentialProviderBinding,
  dispatchCurrentAgentRuntimeDaemonServiceRequest,
  dispatchCurrentRunnerDaemonPluginService,
  attestCurrentRunnerAgentSessionOpen,
  isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition,
  openCurrentRunnerTeamCredentialProviderBinding,
  readCurrentRunnerTeamCredentialBrokerDenial,
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

describe('current Agent runtime daemon service authority client', () => {
  it.each(['hit', 'miss', 'failed', 'cancelled', 'logger_failed'] as const)(
    'records a payload-free runner refusal read once without additional authority reads or RPCs (%s)',
    async outcome => {
      const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-runner-refusal-read-'));
      roots.push(happyHomeDir);
      const command = 'happier runner';
      const runner = { pid: process.pid, processStartTimeMs: 1_717_171_717_000,
        processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:runner-a' };
      processIdentityMock.mockResolvedValue({ pid: process.pid, processStartTimeMs: runner.processStartTimeMs, command });
      runnerIdentityMock.mockReturnValue({ status: 'known', comparableId: runner.snapshotIdentity });
      const authority = await createTestAuthority({ happyHomeDir, runner });
      await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31_001, capability: 'A'.repeat(43) });
      const denial = { v: 1, resourceId: 'PRIVATE_RESOURCE_ID', reasonCode: 'resource_forbidden' } as const;
      const cancellation = new AbortController();
      const fetchMock = vi.fn(async () => {
        if (outcome === 'cancelled') {
          cancellation.abort(new Error('PRIVATE_CANCELLATION'));
          throw cancellation.signal.reason;
        }
        return new Response(JSON.stringify(outcome === 'failed'
          ? { ok: false, error: { code: 'private_failure', message: 'PRIVATE_RESPONSE_BODY' } }
          : { ok: true, result: { kind: 'provider_broker.refusal', denial: outcome === 'miss' ? null : denial } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
      });
      vi.stubGlobal('fetch', fetchMock);
      const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {
        if (outcome === 'logger_failed') throw new Error('PRIVATE_LOG_FAILURE');
      });
      const privateReads = vi.spyOn(privateBearerFile, 'readPrivateBearerFile');
      processIdentityMock.mockClear();
      try {
        const read = readCurrentRunnerTeamCredentialBrokerDenial({ authority, turnId: 'turn-1', signal: cancellation.signal });
        if (outcome === 'cancelled') await expect(read).rejects.toThrow('PRIVATE_CANCELLATION');
        else await expect(read).resolves.toEqual(outcome === 'miss' || outcome === 'failed' ? null : denial);
        expect(log.mock.calls.filter(([message]) => message === '[provider-broker-application]')).toEqual([
          ['[provider-broker-application]', { stage: 'runner-refusal-read', sessionId: 'session-1', turnId: 'turn-1',
            pid: runner.pid, processStartTimeMs: runner.processStartTimeMs,
            outcome: outcome === 'failed' || outcome === 'cancelled' ? 'failed' : outcome === 'miss' ? 'miss' : 'hit',
            ...(outcome === 'failed' || outcome === 'cancelled' ? { reason: 'read_failed' }
              : outcome === 'miss' ? { reason: 'no_evidence' } : {}) }],
        ]);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(privateReads).toHaveBeenCalledTimes(1);
        expect(processIdentityMock).not.toHaveBeenCalled();
      } finally { privateReads.mockRestore(); log.mockRestore(); }
    },
  );

  it.each(['preparation', 'invocation', 'caller', 'invocation-with-caller'] as const)(
    'cancels runner service %s through the real daemon transport',
    async phase => {
      const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-runner-service-cancellation-'));
      roots.push(happyHomeDir);
      const authority = await createTestAuthority({ happyHomeDir, runner: {
        pid: 1234, processStartTimeMs: 1_717_171_717_000,
        processCommandHash: 'a'.repeat(64), snapshotIdentity: 'snapshot:runner-a',
      } });
      const invocation = new AbortController();
      const caller = new AbortController();
      let requestStarted!: () => void;
      const started = new Promise<void>(resolve => { requestStarted = resolve; });
      let closeCompleted!: () => void;
      const closed = new Promise<void>(resolve => { closeCompleted = resolve; });
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const { operation } = JSON.parse(Buffer.concat(chunks).toString()) as {
          operation: { kind: string; requestId: string };
        };
        const reply = (value: Parameters<typeof encodeRunnerDaemonPluginServiceWireValueV1>[0]) => {
          response.end(JSON.stringify({ ok: true, result: {
            kind: 'plugin_services.result_v1', requestId: operation.requestId,
            value: encodeRunnerDaemonPluginServiceWireValueV1(value),
          } }));
        };
        if (operation.kind === 'plugin_services.close_v1') {
          reply(null);
          closeCompleted();
        } else if (operation.kind === 'plugin_services.prepare_v1' && phase !== 'preparation') {
          reply({ availability: { storage: { status: 'available' } },
            storageConsistency: { ephemeral: null, daemonSession: null, daemon: { kind: 'authoritativeSerializable' } },
            settingsDescriptors: { account: [], daemon: [] }, resourceDescriptors: {},
            subscriptionCapabilities: { settingsWatch: false, eventSubscriptions: [], resourceWatches: [], notificationPreferencesWatch: false },
          });
        } else {
          // A connected daemon holds its reply. Only caller lifetime can end this wait.
          requestStarted();
        }
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      await publishAgentRuntimeDaemonServiceAuthority({ ...authority,
        httpPort: address.port, capability: 'A'.repeat(43) });
      const dispatchControllers: AbortController[] = [];
      let observation: Promise<void> | undefined;
      try {
        const preparation = prepareRunnerDaemonPluginServices({ invocationId: 'invocation-1',
          signal: invocation.signal, local: createUnavailablePluginServices(),
          dispatch: (operation, options) => {
            // The emergency transport controller only releases a failing test's owned HTTP wait.
            const transport = new AbortController();
            dispatchControllers.push(transport);
            return dispatchCurrentRunnerDaemonPluginService({ authority, operation, ...options,
              signal: options?.signal ? AbortSignal.any([options.signal, transport.signal]) : transport.signal });
          },
        });
        const pending = phase === 'preparation' ? preparation : (await preparation).storage.daemon.get('held',
          phase === 'invocation' ? undefined : { signal: caller.signal });
        observation = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await started;
        (phase === 'caller' ? caller : invocation).abort();
        // Observe a real event-loop turn without imposing a production deadline.
        let settled = false;
        void observation.then(() => { settled = true; }, () => { settled = true; });
        await vi.waitFor(() => expect(settled).toBe(true));
        await observation;
        if (phase !== 'preparation') {
          invocation.abort();
          await closed;
        }
      } finally {
        invocation.abort();
        for (const controller of dispatchControllers) controller.abort();
        await observation?.catch(() => undefined);
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    },
  );

  it.each(['operation', 'deadline', 'cancellation'] as const)(
    'keeps native launch authorization under its %s lifetime beyond five minutes',
    async (lifetime) => {
      const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-launch-lifetime-'));
      roots.push(happyHomeDir);
      const authority = await createTestAuthority({ happyHomeDir, runner: {
        pid: 1234, processStartTimeMs: 1_717_171_717_000,
        processCommandHash: 'a'.repeat(64), snapshotIdentity: 'snapshot:runner-a',
      } });
      let releaseResponse = () => {};
      let requestStarted!: () => void;
      const started = new Promise<void>(resolve => { requestStarted = resolve; });
      const launch = { authorizationId: 'authorization-1', launch: {
        command: '/agent/native', args: [], env: {},
      } };
      const server = createServer((request, response) => {
        request.resume();
        releaseResponse = () => response.end(JSON.stringify({ ok: true, result: {
          kind: 'plugin_services.result_v1', requestId: 'launch-1',
          value: encodeRunnerDaemonPluginServiceWireValueV1(launch),
        } }));
        requestStarted();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      await publishAgentRuntimeDaemonServiceAuthority({ ...authority,
        httpPort: address.port, capability: 'A'.repeat(43) });
      // Only time is simulated: authority files, HTTP, request/response schemas
      // and the runner service adapter remain real.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
        return controller.signal;
      });
      const cancellation = new AbortController();
      try {
        const pending = dispatchCurrentRunnerDaemonPluginService({ authority,
          operation: { kind: 'plugin_exec.launch.authorize_v1', requestId: 'launch-1',
            invocationId: 'invocation-1', agentNativeLaunch: true,
            request: { executable: { kind: 'systemTool', id: 'fixture-agent' } } },
          ...(lifetime === 'deadline' ? { timeoutMs: 300_000 } : {}),
          signal: cancellation.signal,
        });
        const outcome = lifetime === 'operation' ? expect(pending).resolves.toEqual(launch)
          : lifetime === 'deadline' ? expect(pending.catch(error => {
            throw sanitizeNativeAgentSessionBoundaryError(error, true);
          })).rejects.toMatchObject({
            code: 'native_agent_privileged_effect_outcome_unknown',
            retryable: false,
            details: { cause: { code: 'TimeoutError', stage: 'dispatch' } },
          }) : expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await started;
        if (lifetime === 'cancellation') cancellation.abort();
        await vi.advanceTimersByTimeAsync(301_000);
        releaseResponse();
        await outcome;
      } finally {
        cancellation.abort();
        releaseResponse();
        vi.useRealTimers();
        vi.restoreAllMocks();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    },
  );

  it('preserves a settled Provider transition failure instead of reporting missing daemon authority', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-transition-error-'));
    roots.push(happyHomeDir);
    const authority = await createTestAuthority({ happyHomeDir, runner: {
      pid: 1234, processStartTimeMs: 1_717_171_717_000,
      processCommandHash: 'a'.repeat(64), snapshotIdentity: 'snapshot:runner-a',
    } });
    await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31_001, capability: 'A'.repeat(43) });
    // The daemon HTTP transport is the boundary; authority reading and strict response decoding stay real.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false, error: { code: 'provider_endpoint_unavailable', message: 'provider_endpoint_unavailable' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const selection = ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:acme.plugin/acme-agent', providerConnectionId: 'pc_test', modelId: 'model' });
    if (selection.providerConnectionId === null) throw new Error('Expected a Provider-bound model fixture');
    await expect(authorizeCurrentAgentRuntimeDaemonModelTransition({
      authority, requestId: 'model-transition-failure', timeoutMs: null,
      selection,
    })).rejects.toMatchObject({ code: 'provider_endpoint_unavailable', message: 'provider_endpoint_unavailable' });
  });

  it('admits a new prompt after daemon replacement changes only the runner command witness', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-reattached-input-'));
    roots.push(happyHomeDir);
    const runner = {
      pid: process.pid,
      processStartTimeMs: 23_346,
      processCommandHash: hashProcessCommand('happier runner --launch-wrapper'),
      snapshotIdentity: 'snapshot:runner-a',
    };
    const authority = await createTestAuthority({ happyHomeDir, runner });
    await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });
    await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      runner: {
        ...runner,
        processCommandHash: hashProcessCommand('happier runner --existing-session session-1'),
      },
      httpPort: 31_002,
      capability: 'B'.repeat(43),
    });
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        operation: { kind: 'session.input.admit' },
      });
      return new Response(JSON.stringify({
        ok: true,
        result: {
          kind: 'session.input.admission',
          status: 'resolved',
          admission: { status: 'alreadyAccepted', localId: 'local-reattached' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(admitCurrentRunnerSessionInput({
      authority,
      requestId: 'admission-after-replacement',
      request: {
        v: 1,
        sessionId: authority.sessionId,
        targetMachineId: 'machine-1',
        localId: 'local-reattached',
        content: { t: 'plain', v: { role: 'user' } },
        requestedAction: { v: 1, kind: 'enqueue' },
      },
      timeoutMs: null,
    })).resolves.toEqual({ status: 'alreadyAccepted', localId: 'local-reattached' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).port).toBe('31002');
  });

  it('opens the exact Team credential binding through the current daemon Session authority', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-team-provider-'));
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
    runnerIdentityMock.mockReturnValue({ status: 'known', comparableId: runner.snapshotIdentity });
    const authority = await createTestAuthority({ happyHomeDir, runner });
    await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { operation: Record<string, unknown> };
      if (request.operation.kind === 'provider_broker.binding.close') {
        expect(request.operation).toMatchObject({ bindingId: 'binding-run-1' });
        return new Response(JSON.stringify({
          ok: true,
          result: { kind: 'provider_broker.binding.closed', status: 'closed' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      expect(request.operation).toMatchObject({
        kind: 'provider_broker.binding.open',
        resourceId: 'resource-1',
        expectedResourceRevision: 3,
        agentTargetKey: 'agent:acme.plugin/acme-agent',
        modelId: 'model-1',
      });
      return new Response(JSON.stringify({
        ok: true,
        result: {
          kind: 'provider_broker.binding',
          status: 'opened',
          providerBinding: {
            source: { kind: 'team_resource', resourceId: 'resource-1', resourceRevision: 3 },
            model: { id: 'model-1', name: 'Model 1' },
            upstream: { protocol: 'openai-responses', normalizedUrl: 'http://127.0.0.1:43123/v1', credential: 'apiKey' },
            materialization: { v: 1, kind: 'spawnEnv' },
          },
          environmentOverlay: [{ name: 'OPENAI_API_KEY', value: 'broker-authority', source: 'provider' }],
          additionalRedactionValues: ['broker-authority'],
          bindingId: 'binding-run-1',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(openCurrentRunnerTeamCredentialProviderBinding({
      authority,
      operation: {
        kind: 'provider_broker.binding.open',
        resourceId: 'resource-1',
        expectedResourceRevision: 3,
        agentTargetKey: 'agent:acme.plugin/acme-agent',
        modelId: 'model-1',
      },
    })).resolves.toMatchObject({
      providerBinding: { source: { kind: 'team_resource', resourceId: 'resource-1' } },
    });
    await expect(closeCurrentRunnerTeamCredentialProviderBinding({
      authority,
      operation: { kind: 'provider_broker.binding.close', bindingId: 'binding-run-1' },
    })).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'provider_endpoint_unavailable',
        message: 'PRIVATE_PROVIDER_RESPONSE',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const refusal = await openCurrentRunnerTeamCredentialProviderBinding({
      authority,
      operation: {
        kind: 'provider_broker.binding.open',
        resourceId: 'resource-1',
        expectedResourceRevision: 3,
        agentTargetKey: 'agent:acme.plugin/acme-agent',
        modelId: 'model-1',
      },
    }).then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).toMatchObject({
      message: 'provider_endpoint_unavailable',
      stack: expect.stringContaining('openCurrentRunnerTeamCredentialProviderBinding'),
      code: 'provider_endpoint_unavailable',
      retryable: true,
      action: 'retry',
      connectionId: 'resource-1',
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'team_authentication_required',
        message: 'team_authentication_required',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(openCurrentRunnerTeamCredentialProviderBinding({
      authority,
      operation: {
        kind: 'provider_broker.binding.open',
        resourceId: 'resource-1',
        expectedResourceRevision: 3,
        agentTargetKey: 'agent:acme.plugin/acme-agent',
        modelId: 'model-1',
      },
    })).rejects.toMatchObject({
      name: 'TeamCredentialDirectMaterialOperationError',
      code: 'team_authentication_required',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

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
      .mockRejectedValueOnce(new TypeError('daemon response lost after dispatch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error: {
          code: 'agent_runtime_daemon_service_generation_not_current',
          message: 'Runner generation is not current',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
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
    await expect(admitCurrentRunnerSessionInput({
      authority,
      requestId: 'admission-stale-generation',
      request,
      timeoutMs: null,
    })).resolves.toEqual({ status: 'rejected', code: 'session_input_source_authority_mismatch' });

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
    expect(fetchMock).toHaveBeenCalledTimes(3);
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

    // MCP keeps the same effect classification, but its file-log evidence must
    // retain the control-route refusal before that classification collapses it.
    for (const [status, code, effectCode, diagnosticCode] of [
      [503, 'agent_runtime_daemon_service_admission_custody_unavailable', 'native_agent_privileged_effect_outcome_unknown', 'agent_runtime_daemon_service_admission_custody_unavailable'],
      [403, 'agent_runtime_daemon_service_forbidden', 'native_agent_privileged_effect_authority_unavailable', 'agent_runtime_daemon_service_forbidden'],
      [503, 'daemon_draining', 'native_agent_privileged_effect_authority_unavailable', 'daemon_draining'],
      [503, 'private-response-body', 'native_agent_privileged_effect_authority_unavailable', 'mcp_request_auth_unavailable'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false,
        error: { code, message: 'private-response-body' } }, { status })));
      const refused = await dispatchCurrentAgentRuntimeDaemonServiceRequest({ authority,
        createRequest: token => ({ v: 1, context: { token, sessionId: 'session-1' },
          operation: { kind: 'mcp.request_auth.open', requestId: 'own-oauth', serverId: 'own-oauth',
            resource: 'https://private-resource.example.test/mcp', materializationId: 'own-oauth' } }) });
      expect(refused).toMatchObject({ ok: false, error: { code: effectCode,
        cause: { code: diagnosticCode, stage: 'dispatch' } } });
      expect(JSON.stringify(refused)).not.toContain('private-response-body');
      expect(JSON.stringify(refused)).not.toContain('private-resource');
    }

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
