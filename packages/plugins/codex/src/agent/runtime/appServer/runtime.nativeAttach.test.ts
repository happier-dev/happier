import { describe, expect, it, vi } from 'vitest';
import {
  buildConnectedServiceCredentialRecord,
  StrictJsonValueSchema,
} from '@happier-dev/protocol';
import type {
  AgentExecutionRunConversationEventV1,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import { createCodexNativeAppServerSessionRuntime } from './native.js';
import { startCodexAppServerRuntime } from './runtime.js';
import {
  withCodexNativeAttachFixture as withFixture,
  codexNativePreparationFailureCases,
  codexNativeRetryProviderBinding,
  codexNativeStartupAuthFailureCases,
} from './runtime.nativeAttach.test-support.js';
import { sanitizeNativeAgentSessionBoundaryError } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { classifyPrimarySessionRuntimeIssue, readSessionPreparationFailureDiagnostic } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import { buildCodexCloudAuthFile } from '../../auth/services/openai/cloud/authFile.js';
import { createNativeAgentSessionInteractionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { SessionInputAuthorityV1Schema, SESSION_INPUT_AUTHORITY_META_KEY, buildTrustedHostSessionInputAdmissionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { UserMessage } from '@/api/types';
import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { createRunnerDaemonPluginServicesPreparationError } from '@/daemon/agentRuntime/runnerDaemonPluginServicesHost';
import { SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH, SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

// The fixture owns TMPDIR. Isolate the OS-user startup lock from live Agents,
// while retaining the real file-lock and native socket/client behavior.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    userInfo: () => ({
      ...actual.userInfo(),
      homedir: process.env.TMPDIR || actual.userInfo().homedir,
    }),
  };
});

describe('native Codex attachment preparation', () => {
  it('retains the native host refusal code and redacted message through the startup terminal', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    await withFixture(async ({ openConfiguredSession }) => {
      const failure: unknown = await openConfiguredSession().catch(error => error);
      const retained = sanitizeNativeAgentSessionBoundaryError(failure, true);
      const diagnostic = readSessionPreparationFailureDiagnostic(retained);
      const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({
        cause: 'session_error', error: retained, provider: 'codex', occurredAt: 100,
      }));
      expect(diagnostic).toMatchObject({ failureCause: {
        code: 'plugin_exec_native_launch_qualifier_invalid', phase: 'client_start',
        providerErrorMessage: expect.stringContaining('Native Agent launch qualifier is invalid'),
      } });
      expect(diagnostic.failureCause?.providerErrorMessage).toContain('[REDACTED]');
      expect(issue.failureCause).toEqual(diagnostic.failureCause);
      expect(logger.warn).toHaveBeenCalledWith('Codex native startup failed', expect.objectContaining({
        failureCause: diagnostic.failureCause,
      }));
      expect(JSON.stringify([diagnostic, issue, logger.warn.mock.calls])).not.toContain('private-native-token');
    }, { logger, nativeSpawnFailure: new PluginError({
      code: 'plugin_exec_native_launch_qualifier_invalid',
      message: 'Native Agent launch qualifier is invalid; api_key=private-native-token',
    }) });
  });

  it.each([
    { stage: 'spawn', options: { nativeSpawnFailure: new Error('Native launch refused: api_key=private-native-token') } },
    { stage: 'process observation', options: { nativeProcessFailure: new Error('Native wait failed: Bearer private-native-token') } },
    { stage: 'initialize', options: { initializeFailure: { code: -32000, message: 'Native initialize refused: api_key=private-native-token' } } },
  ])('retains a closed category and sanitized native preview from $stage in runner and Session failures', async ({ stage, options }) => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    await withFixture(async ({ openConfiguredSession }) => {
      const failure: unknown = await openConfiguredSession().catch(error => error);
      const retained = sanitizeNativeAgentSessionBoundaryError(failure, true);
      const diagnostic = readSessionPreparationFailureDiagnostic(retained);
      const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({
        cause: 'session_error', error: retained, provider: 'codex', occurredAt: 100,
      }));
      const code = stage === 'initialize' ? 'agent_startup_rpc_rejected' : 'agent_startup_transport_failed';
      expect(diagnostic).toMatchObject({ originalCode: code, reason: code,
        failureCause: { phase: 'client_start', providerErrorMessage: expect.stringContaining('[REDACTED]') } });
      expect(issue).toMatchObject({ code, failureCause: diagnostic.failureCause });
      expect(logger.warn).toHaveBeenCalledWith('Codex native startup failed', expect.objectContaining({
        failureCause: diagnostic.failureCause,
      }));
      expect(JSON.stringify([diagnostic, issue, logger.warn.mock.calls])).not.toContain('private-native-token');
    }, { logger, ...options });
  });

  it('retains a redacted bounded stderr preview when the native proxy exits before its handshake is ready', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    await withFixture(async ({ openConfiguredSession }) => {
      const failure: unknown = await openConfiguredSession().catch(error => error);
      const retained = sanitizeNativeAgentSessionBoundaryError(failure, true);
      const diagnostic = readSessionPreparationFailureDiagnostic(retained);
      const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({
        cause: 'session_error', error: retained, provider: 'codex', occurredAt: 100,
      }));
      expect(diagnostic).toMatchObject({ originalCode: 'agent_startup_transport_failed', reason: 'agent_startup_transport_failed', failureCause: {
        phase: 'client_start', providerErrorMessage: expect.stringContaining('Native proxy refused:'),
      } });
      expect(issue.failureCause).toEqual(diagnostic.failureCause);
      expect(diagnostic.failureCause?.providerErrorMessage).toContain('[REDACTED]');
      expect(diagnostic.failureCause?.providerErrorMessage).toHaveLength(SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH);
      expect(logger.warn).toHaveBeenCalledWith('Codex native startup failed', expect.objectContaining({
        failureCause: diagnostic.failureCause,
      }));
      expect(JSON.stringify([diagnostic, issue, logger.warn.mock.calls])).not.toContain('private-proxy-token');
    }, { logger, nativeProxyStderr: `Native proxy refused: api_key=private-proxy-token; ${'x'.repeat(SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH)}` });
  });

  it('retains native process stderr in the warning and runner diagnostic through the Session boundary', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    await withFixture(async ({ openConfiguredSession }) => {
      const failure: unknown = await openConfiguredSession().catch(error => error);
      const diagnostic = readSessionPreparationFailureDiagnostic(failure);
      expect(diagnostic).toMatchObject({ originalCode: 'agent_startup_transport_failed',
        reason: 'agent_startup_transport_failed', failureCause: {
          phase: 'client_start', providerErrorMessage: 'CODEX_HOME does not exist; Bearer [REDACTED]',
        } });
      expect(logger.warn).toHaveBeenCalledWith('Codex native startup failed', expect.objectContaining({
        failureCause: expect.objectContaining({ providerErrorMessage: diagnostic.failureCause?.providerErrorMessage }),
      }));
      expect(JSON.stringify([diagnostic, logger.warn.mock.calls])).not.toMatch(/private-native-token|PRIVATE_MESSAGE/);
    }, { logger, nativeProcessResult: {
      termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } },
      stdout: new Uint8Array(), stderr: new TextEncoder().encode('CODEX_HOME does not exist; Bearer private-native-token'),
      stdoutTruncated: false, stderrTruncated: false,
    } });
  });

  it.each(['session', 'run'] as const)('retains %s startup rejection when native cleanup also fails', async surface => {
    await withFixture(async ({ openConfiguredSession, openConfiguredRun, failResume, nativeProcessExits }) => {
      failResume('Native startup refused: Bearer private-provider-token');
      const failure: unknown = await (surface === 'session' ? openConfiguredSession() : openConfiguredRun('existing-thread'))
        .catch(error => error);
      const retained = sanitizeNativeAgentSessionBoundaryError(failure, true);
      const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({
        cause: 'session_error', error: retained, provider: 'codex', occurredAt: 100,
      }));
      expect(retained).toMatchObject({ code: 'agent_startup_rpc_rejected', details: { failureCause: {
        phase: 'thread_open', providerErrorCode: -32000,
      } } });
      expect(issue).toMatchObject({ code: 'agent_startup_rpc_rejected', failureCause: { providerErrorCode: -32000 } });
      expect(nativeProcessExits.length).toBeGreaterThan(0);
      expect(JSON.stringify(issue)).not.toContain('private-provider-token');
      expect(JSON.stringify(issue)).not.toContain('PRIVATE_CLEANUP_PATH');
    }, { threadStartFailure: { code: -32000, message: 'Native startup refused: Bearer private-provider-token' },
      nativeCleanupFailure: Object.assign(new Error('PRIVATE_CLEANUP_PATH'), { code: 'EACCES' }) });
  });

  it('retains redacted provider rejection details through public native startup and issue publication', async () => {
    await withFixture(async ({ openConfiguredSession, requests }) => {
      const failure = await openConfiguredSession().then(
        () => { throw new Error('Expected native startup refusal'); },
        (error: unknown) => error,
      );
      const retained = sanitizeNativeAgentSessionBoundaryError(failure, true);
      const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({
        cause: 'session_error', error: retained, provider: 'codex', occurredAt: 100,
      }));
      expect(retained).toMatchObject({ code: 'agent_startup_rpc_rejected', details: { failureCause: {
        phase: 'thread_open', providerErrorCode: -32603,
        providerErrorMessage: expect.stringContaining('Thread creation failed:'),
      } } });
      expect(issue).toMatchObject({ failureCause: {
        phase: 'thread_open', providerErrorCode: -32603,
        providerErrorMessage: expect.stringContaining('[REDACTED]'),
      } });
      for (const value of [failure, retained, issue]) {
        expect(JSON.stringify(value)).not.toContain('private-provider-token');
        expect(JSON.stringify(value)).not.toContain('private-api-key');
      }
      expect(requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
      expect(requests.some(request => request.method === 'turn/start')).toBe(false);
    }, { threadStartFailure: {
      code: -32603,
      message: 'Thread creation failed: Bearer private-provider-token; api_key=private-api-key',
    } });
  });

  it('retains the daemon preparation stage through native Session startup rejection and issue publication', async () => {
    const preparationError = createRunnerDaemonPluginServicesPreparationError(
      Object.assign(new Error('PRIVATE_PROVIDER_RESPONSE'), { code: 'ENOENT', path: '/PRIVATE_SOCKET' }),
      'registry_acquisition',
    );
    await withFixture(async ({ runtime, requests }) => {
      const session = createCodexNativeAppServerSessionRuntime(runtime, 'actual-happier-session');
      try {
        const result = await session.send({ inputIds: ['preparation-input'], input: { text: 'PRIVATE_PROMPT' },
          delivery: { kind: 'newTurn', turnId: 'preparation-turn' } });
        expect(result).toMatchObject({ status: 'rejected', retryable: false });
        if (result.status !== 'rejected') throw new Error('Expected preparation rejection');
        const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({
          cause: 'session_error', provider: 'codex', error: result.diagnostic, occurredAt: 100,
        }));
        expect(issue).toMatchObject({ code: 'runner_plugin_services_unavailable', failureCause: {
          phase: 'client_start', preparationCause: { code: 'ENOENT', stage: 'registry_acquisition' },
        } });
        expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(0);
        expect(JSON.stringify([result, issue])).not.toContain('PRIVATE_');
      } finally {
        await session.dispose();
      }
    }, { clientStartFailure: preparationError });
  });

  it.each(codexNativeStartupAuthFailureCases())('retains the closed startup auth cause across the host boundary: $reason', async ({ reason, target, options }) => {
    const logged: unknown[] = [];
    await withFixture(async ({ openConfiguredSession, openConfiguredRun, requests }) => {
      const failure = await (target === 'run' ? openConfiguredRun('fixture-existing-thread') : openConfiguredSession())
        .then(() => { throw new Error('Expected native startup refusal'); }, error => error as unknown);
      expect(failure).toMatchObject({ code: 'codex_refresh_free_auth_unsupported', details: { reason } });
      const retained = sanitizeNativeAgentSessionBoundaryError(failure, true);
      expect(retained).toMatchObject({ code: 'codex_refresh_free_auth_unsupported', details: { reason } });
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: retained, provider: 'codex', occurredAt: 100 });
      expect(readSessionPreparationFailureDiagnostic(retained)).toMatchObject({ reason });
      expect(issue).toMatchObject({ code: 'codex_refresh_free_auth_unsupported', failureCause: { phase: 'authentication', reason },
        source: reason === 'refresh_bridge_unavailable' || reason === 'experimental_api_unavailable' ? 'dependency_failure' : 'auth_error' });
      expect(JSON.stringify([retained, issue])).not.toContain('PRIVATE_');
      expect(logged).toContainEqual(expect.objectContaining({ failureCause: expect.objectContaining({ reason }) }));
      expect(JSON.stringify(logged)).not.toContain('PRIVATE_');
      expect(requests.some(request => request.method === 'thread/start' || request.method === 'turn/start')).toBe(false);
    }, { ...options, logger: { debug: (_message, fields) => { logged.push(fields); }, warn: (_message, fields) => { logged.push(fields); } } });
  });

  it('does not let an unknown terminal receipt claim the turn before its start acknowledgement', async () => {
    let releaseStart!: () => void;
    const startHeld = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    await withFixture(
      async ({ runtime, requests, emitNotification }) => {
        const session = createCodexNativeAppServerSessionRuntime(
          runtime,
          'actual-happier-session',
        );
        const events: AgentSessionRuntimeEvent[] = [];
        session.watch((event) => events.push(event));
        try {
          const send = session.send({
            inputIds: ['pre-ack-input'],
            input: { text: 'Reply OK.' },
            delivery: { kind: 'newTurn', turnId: 'pre-ack-host-turn' },
          });
          await vi.waitFor(() =>
            expect(
              requests.some((request) => request.method === 'turn/start'),
            ).toBe(true),
          );
          emitNotification('turn/completed', {
            threadId: 'fresh-thread',
            id: 'unrelated-old-turn',
            status: 'completed',
          });
          releaseStart();
          await send;
          // WebSocket order puts the terminal receipt before the start response.
          expect(events.some((event) => event.kind === 'turn-complete')).toBe(
            false,
          );
          emitNotification('turn/completed', {
            threadId: 'fresh-thread',
            turn: { id: 'provider-turn-1', status: 'completed' },
          });
          await vi.waitFor(() =>
            expect(events.some((event) => event.kind === 'turn-complete')).toBe(
              true,
            ),
          );
          expect(
            events.find((event) => event.kind === 'turn-complete'),
          ).toMatchObject({
            turnId: 'pre-ack-host-turn',
            agentTurnId: 'provider-turn-1',
          });
        } finally {
          releaseStart();
          await session.dispose();
        }
      },
      { beforeTurnStartResponse: async () => await startHeld },
    );
  });

  it.each([false, true])(
    'settles an owned early terminal after start acknowledgement (prior native binding: %s)',
    async (bindBeforeTerminal) => {
      let releaseStart!: () => void;
      const startHeld = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      await withFixture(
        async ({ runtime, requests, emitNotification }) => {
          const session = createCodexNativeAppServerSessionRuntime(
            runtime,
            'actual-happier-session',
          );
          const events: AgentSessionRuntimeEvent[] = [];
          session.watch((event) => events.push(event));
          try {
            const send = session.send({
              inputIds: ['owned-early-input'],
              input: { text: 'Reply OK.' },
              delivery: { kind: 'newTurn', turnId: 'owned-early-host-turn' },
            });
            await vi.waitFor(() =>
              expect(
                requests.some((request) => request.method === 'turn/start'),
              ).toBe(true),
            );
            if (bindBeforeTerminal) {
              emitNotification('turn/started', {
                threadId: 'fresh-thread',
                turn: { id: 'provider-turn-1' },
              });
            }
            emitNotification('turn/completed', {
              threadId: 'fresh-thread',
              turn: { id: 'provider-turn-1', status: 'completed' },
            });
            releaseStart();
            await send;
            await vi.waitFor(() =>
              expect(
                events.some((event) => event.kind === 'turn-complete'),
              ).toBe(true),
            );
            expect(
              events.find((event) => event.kind === 'turn-complete'),
            ).toMatchObject({
              turnId: 'owned-early-host-turn',
              agentTurnId: 'provider-turn-1',
            });
          } finally {
            releaseStart();
            await session.dispose();
          }
        },
        { beforeTurnStartResponse: async () => await startHeld },
      );
    },
  );

  it('settles the submitted input from matching native activity when the successful start reply is lost', async () => {
    await withFixture(async ({ runtime, requests }) => {
      const session = createCodexNativeAppServerSessionRuntime(runtime, 'actual-happier-session');
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch(event => events.push(event));
      try {
        const send = session.send({ inputIds: ['lost-ack-input'], input: { text: 'Reply OK.' },
          delivery: { kind: 'newTurn', turnId: 'lost-ack-host-turn' } });
        let settlement: unknown;
        void send.then(result => { settlement = result; }, error => { settlement = error; });
        await vi.waitFor(() => expect(settlement).toMatchObject({ status: 'admitted' }));
        await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
          kind: 'turn-complete', turnId: 'lost-ack-host-turn', agentTurnId: 'provider-turn-1',
        })));
        expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
      } finally {
        await session.dispose();
      }
    }, {
      dropSuccessfulTurnStartResponse: true,
      onTurnStart({ socket, params, turnId }) {
        socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId } } }));
        socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } }));
      },
    });
  });

  it('keeps nonterminal native diagnostics separate from actual completion', async () => {
    await withFixture(async ({ runtime, emitNotification }) => {
      const session = createCodexNativeAppServerSessionRuntime(
        runtime,
        'actual-happier-session',
      );
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch((event) => events.push(event));
      try {
        await session.send({
          inputIds: ['native-input'],
          input: { text: 'Reply OK.' },
          delivery: { kind: 'newTurn', turnId: 'native-host-turn' },
        });
        emitNotification('error', {
          threadId: 'fresh-thread',
          turnId: 'provider-turn-1',
          willRetry: false,
          error: { message: 'native diagnostic only' },
        });
        expect(events.some((event) => event.kind === 'turn-failed')).toBe(
          false,
        );
        for (const [threadId, turnId] of [
          ['other-thread', 'provider-turn-1'],
          ['fresh-thread', 'old-turn'],
        ]) {
          emitNotification('error', {
            threadId,
            turnId,
            error: { message: 'foreign' },
          });
        }
        emitNotification('turn/completed', {
          threadId: 'fresh-thread',
          id: 'old-turn',
          status: 'completed',
        });
        emitNotification('turn/completed', {
          threadId: 'fresh-thread',
          turn: { id: 'provider-turn-1', status: 'completed' },
        });
        await vi.waitFor(() =>
          expect(events.some((event) => event.kind === 'turn-complete')).toBe(
            true,
          ),
        );
        const settledCount = events.length;
        emitNotification('error', {
          threadId: 'fresh-thread',
          turnId: 'provider-turn-1',
          error: { message: 'late' },
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(events).toHaveLength(settledCount);
      } finally {
        await session.dispose();
      }
    });
  });

  it.each([
    { variant: 'httpConnectionFailed', status: 401, providerCode: 'provider_endpoint_unauthorized' },
    { variant: 'responseStreamConnectionFailed', status: 401, providerCode: 'provider_endpoint_unauthorized' },
    { variant: 'httpConnectionFailed', status: 403, providerCode: null },
    { variant: 'httpConnectionFailed', status: 500, providerCode: null },
    { variant: 'httpConnectionFailed', status: null, providerCode: 'provider_endpoint_unreachable' },
    { variant: 'responseStreamConnectionFailed', status: null, providerCode: 'provider_endpoint_unreachable' },
    { variant: 'responseStreamDisconnected', status: null, providerCode: 'provider_endpoint_unreachable' },
    { variant: 'responseTooManyFailedAttempts', status: null, providerCode: null },
    { variant: 'other', status: null, providerCode: null },
  ])('attributes a Provider terminal transport failure without native sign-in recovery ($variant/$status)', async ({ variant, status, providerCode }) => {
    await withFixture(async ({ openConfiguredSession, emitNotification }) => {
      const session = await openConfiguredSession();
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch(event => events.push(event));
      await session.send({ inputIds: ['provider-auth-input'], input: { text: 'hello' },
        delivery: { kind: 'newTurn', turnId: 'provider-auth-turn' } });
      emitNotification('turn/completed', { threadId: 'fresh-thread', turn: {
        id: 'provider-turn-1', status: 'failed', error: {
          message: 'invalid API key: {"error":{"message":"PRIVATE_PROVIDER_RESPONSE"}}',
          codexErrorInfo: variant === 'other' ? 'other' : { [variant]: { httpStatusCode: status } },
        },
      } });
      await vi.waitFor(() => expect(events.some(event => event.kind === 'turn-failed')).toBe(true));
      const failed = events.find(event => event.kind === 'turn-failed');
      if (failed?.kind !== 'turn-failed') throw new Error('Missing terminal failure');
      expect(failed.diagnostic.details).not.toHaveProperty('runtimeAuthClassification');
      if (providerCode) {
        const retryable = providerCode === 'provider_endpoint_unreachable';
        expect(failed.diagnostic).toMatchObject({ code: providerCode, details: {
          providerError: { v: 1, code: providerCode, connectionId: 'pc_work',
            retryable, action: retryable ? 'retry' : 'replace_secret' },
          failureCause: { code: providerCode,
            ...(status === null ? {} : { httpStatus: status }) },
        } });
        expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failed.diagnostic,
          provider: 'codex', occurredAt: 100 })).toMatchObject({ code: providerCode, source: 'agent_session_error' });
      } else {
        expect(failed.diagnostic.code).not.toBe('provider_endpoint_unauthorized');
        expect(failed.diagnostic.code).not.toBe('provider_endpoint_unreachable');
        expect(failed.diagnostic.details).not.toHaveProperty('providerError');
      }
      expect(JSON.stringify(events)).not.toContain('PRIVATE_');
    }, { providerBinding: {
      connectionId: 'pc_work', model: { id: 'fixture-model', name: 'Fixture' },
      upstream: { protocol: 'openai-responses', normalizedUrl: 'https://gateway.example.test/v1', credential: 'apiKey' },
      materialization: { v: 1, kind: 'engineConfig', engineConfig: { v: 1, modelProvider: 'ollama', config: {} } },
    } });
  });

  it('publishes one safe cause for repeated terminal evidence and still reaches a second failed turn', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    await withFixture(
      async ({ runtime, requests, emitNotification }) => {
        const session = createCodexNativeAppServerSessionRuntime(
          runtime,
          'actual-happier-session',
        );
        const events: AgentSessionRuntimeEvent[] = [];
        session.watch((event) => events.push(event));
        try {
          for (let occurrence = 1; occurrence <= 2; occurrence += 1) {
            await expect(
              session.send({
                inputIds: [`cause-input-${occurrence}`],
                input: { text: 'hello' },
                delivery: {
                  kind: 'newTurn',
                  turnId: `cause-turn-${occurrence}`,
                },
              }),
            ).resolves.toMatchObject({ status: 'admitted' });
            const terminal = {
              threadId: 'fresh-thread',
              turn: {
                id: `provider-turn-${occurrence}`,
                status: 'failed',
                error: {
                  message: 'HTTP 401: {"error":{"message":"PRIVATE_PROVIDER_RESPONSE"}}',
                  codexErrorInfo: {
                    httpConnectionFailed: { httpStatusCode: 401 },
                  },
                },
              },
            };
            for (let duplicate = 0; duplicate < 10; duplicate += 1)
              emitNotification('turn/completed', terminal);
            await vi.waitFor(() =>
              expect(
                events.filter((event) => event.kind === 'turn-failed'),
              ).toHaveLength(occurrence),
            );
            expect(
              events.filter((event) => event.kind === 'turn-failed').at(-1),
            ).toMatchObject({
              turnId: `cause-turn-${occurrence}`,
              diagnostic: {
                code: 'provider_endpoint_auth_required',
                details: {
                  failureCause: {
                    phase: 'turn',
                    failureReason: 'authentication_required',
                    httpStatus: 401,
                  },
                },
              },
            });
            expect(logger.warn).toHaveBeenCalledTimes(occurrence);
            expect(
              requests.filter((request) => request.method === 'turn/start'),
            ).toHaveLength(occurrence);
          }
          expect(
            JSON.stringify([events, logger.warn.mock.calls]),
          ).not.toContain('PRIVATE_');
        } finally {
          await session.dispose();
        }
      },
      { logger },
    );
  });

  it.each(codexNativePreparationFailureCases())(
    'retains preparation cause at the native Session boundary: $title',
    async ({ phase, code, retryable, options }) => {
      const logger = { debug: vi.fn(), warn: vi.fn() };
      await withFixture(
        async ({ runtime, requests }) => {
          const session = createCodexNativeAppServerSessionRuntime(
            runtime,
            'actual-happier-session',
          );
          const events: AgentSessionRuntimeEvent[] = [];
          session.watch((event) => events.push(event));
          try {
            const result = await session.send({
              inputIds: ['cause-input'],
              input: { text: 'PRIVATE_PROMPT' },
              delivery: { kind: 'newTurn', turnId: 'cause-turn' },
            });
            expect(result).toMatchObject({
              status: 'rejected',
              retryable,
              diagnostic: {
                code,
                details: { failureCause: { phase } },
              },
            });
            if ('initializeFailure' in options)
              expect(result).toMatchObject({
                diagnostic: {
                  details: {
                    failureCause: {
                      providerErrorCode: options.initializeFailure.code,
                      providerErrorMessage: expect.stringContaining('[REDACTED]'),
                    },
                  },
                },
              });
            expect(
              events.filter((event) => event.kind === 'input-rejected'),
            ).toHaveLength(1);
            expect(
              events.filter((event) =>
                ['turn-start', 'turn-failed', 'input-custody-unknown'].includes(
                  event.kind,
                ),
              ),
            ).toHaveLength(0);
            expect(
              requests.filter((request) => request.method === 'turn/start'),
            ).toHaveLength(0);
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(
              JSON.stringify([result, events, logger.warn.mock.calls]),
            ).not.toContain('PRIVATE_');
          } finally {
            await session.dispose();
          }
        },
        { ...options, logger },
      );
    },
  );

  it.each([
    { kind: 'create', customProvider: false },
    { kind: 'resume', customProvider: false },
    { kind: 'create', customProvider: true },
    { kind: 'resume', customProvider: true },
  ] as const)(
    'uses provider-bounded retries for a $kind Run (custom Provider: $customProvider) and retains ownership until terminal',
    async ({ kind, customProvider }) => {
      const logger = { debug: vi.fn(), warn: vi.fn() };
      const modelProvider = 'happier_0123456789abcdef0123456789abcdef';
      const providerBinding = customProvider
        ? codexNativeRetryProviderBinding()
        : undefined;
      await withFixture(
        async ({ runtime, openConfiguredRun, requests, emitNotification }) => {
          if (kind === 'resume') await runtime.prepareProviderCliAttach();
          const run = await openConfiguredRun(
            kind === 'resume' ? 'fresh-thread' : undefined,
          );
          const events: AgentExecutionRunConversationEventV1[] = [];
          run.watch((event) => events.push(event));
          await expect(
            run.send({
              inputIds: ['retry-input'],
              input: { text: 'Reply OK.' },
              delivery: { kind: 'newTurn', turnId: 'retry-turn' },
            }),
          ).resolves.toMatchObject({ status: 'admitted' });
          expect(
            requests.findLast(
              (request) =>
                request.method ===
                (kind === 'resume' ? 'thread/resume' : 'thread/start'),
            )?.params,
          ).toMatchObject({
            ...(customProvider ? { modelProvider } : {}),
            config: {
              ...providerBinding?.materialization.engineConfig.config,
              'features.unbounded_connection_retries': false,
            },
          });
          expect(logger.debug).toHaveBeenCalledWith(
            'Codex app-server thread retry policy',
            {
              method: kind === 'resume' ? 'thread/resume' : 'thread/start',
              isExecutionRun: true,
              hasUnboundedConnectionRetriesOverride: true,
              unboundedConnectionRetries: false,
            },
          );

          // rust-v0.162.1 responses_retry.rs -> bespoke_event_handling.rs: a retry
          // diagnostic is nonterminal, and exhaustion emits error then turn/completed.
          const error = {
            codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
            message: 'Connection failed',
          };
          const retryCount = requests.length;
          emitNotification('error', {
            threadId: 'fresh-thread',
            turnId: 'provider-turn-1',
            willRetry: true,
            error,
          });
          emitNotification('error', {
            threadId: 'fresh-thread',
            turnId: 'provider-turn-1',
            willRetry: false,
            error,
          });
          // Wait for the transport-delivered nonterminal diagnostic before checking ownership.
          await vi.waitFor(() =>
            expect(logger.debug).toHaveBeenCalledWith(
              'Codex app-server awaiting terminal notification after provider error',
              expect.objectContaining({ willRetry: false }),
            ),
          );
          expect(
            events.filter((event) =>
              ['turn-failed', 'turn-complete', 'turn-cancelled'].includes(
                event.kind,
              ),
            ),
          ).toEqual([]);
          expect(
            requests
              .slice(retryCount)
              .some(
                (request) =>
                  request.method === 'turn/start' ||
                  request.method === 'turn/interrupt',
              ),
          ).toBe(false);

          emitNotification('turn/completed', {
            threadId: 'fresh-thread',
            turn: {
              id: 'provider-turn-1',
              status: 'failed',
              error,
            },
          });
          await vi.waitFor(() =>
            expect(events).toContainEqual(
              expect.objectContaining({
                kind: 'turn-failed',
                turnId: 'retry-turn',
                agentTurnId: 'provider-turn-1',
                diagnostic: expect.objectContaining({
                  code: 'codex_app_server_turn_failed',
                }),
              }),
            ),
          );
          expect(
            events.filter((event) => event.kind === 'turn-failed'),
          ).toHaveLength(1);
        },
        { logger, providerBinding },
      );
    },
  );

  it.each(['create', 'resume'] as const)('excludes inherited ChatGPT apps from a custom-provider %s Session', async kind => {
    await withFixture(async ({ runtime, openConfiguredSession, requests }) => {
      if (kind === 'resume') await runtime.prepareProviderCliAttach();
      await openConfiguredSession(kind === 'resume' ? 'fresh-thread' : undefined);
      const request = requests.findLast(row => row.method === (kind === 'resume' ? 'thread/resume' : 'thread/start'));
      expect(request?.params.config).toMatchObject({ 'features.apps': false });
    }, { providerBinding: codexNativeRetryProviderBinding() });
  });

  it('preserves native connection retry policy for interactive Sessions', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    await withFixture(
      async ({ openConfiguredSession, requests }) => {
        await openConfiguredSession();
        const config = requests.findLast(
          (request) => request.method === 'thread/start',
        )?.params.config;
        expect(config ?? {}).not.toHaveProperty(
          'features.unbounded_connection_retries',
        );
        expect(logger.debug).toHaveBeenCalledWith(
          'Codex app-server thread retry policy',
          {
            method: 'thread/start',
            isExecutionRun: false,
            hasUnboundedConnectionRetriesOverride: false,
          },
        );
      },
      { logger },
    );
  });

  it('projects correlated native retries without settling or restarting the interactive turn', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    await withFixture(
      async ({ openConfiguredSession, requests, emitNotification }) => {
        const session = await openConfiguredSession();
        const events: AgentSessionRuntimeEvent[] = [];
        session.watch((event) => events.push(event));
        const progress = () =>
          events.filter((event) => event.kind === 'turn-progress');
        const retry = (
          error: Record<string, unknown>,
          extra: Record<string, unknown> = {},
        ) =>
          emitNotification('error', {
            threadId: 'fresh-thread',
            turnId: 'provider-turn-1',
            willRetry: true,
            error,
            ...extra,
          });
        const connectionError = {
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } },
          message: 'PRIVATE_PROVIDER_RESPONSE',
        };
        try {
          await expect(
            session.send({
              inputIds: ['retry-visible-input'],
              input: { text: 'Reply OK.' },
              delivery: { kind: 'newTurn', turnId: 'retry-visible-turn' },
            }),
          ).resolves.toMatchObject({ status: 'admitted' });
          retry(connectionError);
          await vi.waitFor(() => expect(progress()).toHaveLength(1));
          expect(progress()[0]).toMatchObject({
            turnId: 'retry-visible-turn',
            agentTurnId: 'provider-turn-1',
            retry: { attempt: 1, reason: 'connection_failed' },
          });
          retry(connectionError, { threadId: 'foreign-thread' });
          retry(connectionError, { turnId: 'foreign-turn' });
          retry(connectionError, { willRetry: false });
          // rust-v0.162.1 app-server-protocol/protocol/v2/shared.rs: typed
          // status/variant evidence wins over any private provider prose.
          const retryCases = [
            {
              codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } },
              reason: 'rate_limited',
            },
            {
              codexErrorInfo: {
                responseStreamConnectionFailed: { httpStatusCode: 503 },
              },
              reason: 'server_error',
            },
            {
              codexErrorInfo: {
                responseStreamConnectionFailed: { httpStatusCode: null },
              },
              reason: 'connection_failed',
            },
            {
              codexErrorInfo: {
                responseStreamDisconnected: { httpStatusCode: null },
              },
              reason: 'connection_failed',
            },
            {
              codexErrorInfo: {
                responseTooManyFailedAttempts: { httpStatusCode: 429 },
              },
              reason: 'rate_limited',
            },
            { codexErrorInfo: 'rateLimitExceeded', reason: 'rate_limited' },
            { codexErrorInfo: 'serverOverloaded', reason: 'server_error' },
            { codexErrorInfo: 'internalServerError', reason: 'server_error' },
            { codexErrorInfo: 'other', reason: 'unknown' },
          ];
          for (const [index, testCase] of retryCases.entries()) {
            retry({
              codexErrorInfo: testCase.codexErrorInfo,
              message: 'Connection failed; rate limit; PRIVATE_RESPONSE',
            });
            await vi.waitFor(() => expect(progress()).toHaveLength(index + 2));
            expect(progress().at(-1)).toMatchObject({
              retry: { attempt: index + 2, reason: testCase.reason },
            });
          }
          const attempts = retryCases.length + 1;
          emitNotification('item/agentMessage/delta', {
            threadId: 'fresh-thread',
            turnId: 'provider-turn-1',
            itemId: 'retry-resumed-message',
            delta: 'Recovered',
          });
          await vi.waitFor(() => expect(progress()).toHaveLength(attempts + 1));
          expect(progress().at(-1)).not.toHaveProperty('retry');
          emitNotification('item/agentMessage/delta', {
            threadId: 'fresh-thread',
            turnId: 'provider-turn-1',
            itemId: 'retry-resumed-message',
            delta: ' more progress',
          });
          retry(connectionError);
          await vi.waitFor(() => expect(progress()).toHaveLength(attempts + 2));
          expect(progress().at(-1)).toMatchObject({
            retry: { attempt: attempts + 1, reason: 'connection_failed' },
          });
          expect(
            events.filter((event) =>
              ['turn-failed', 'turn-complete', 'turn-cancelled'].includes(
                event.kind,
              ),
            ),
          ).toEqual([]);
          expect(
            requests.filter((request) => request.method === 'turn/start'),
          ).toHaveLength(1);
          expect(
            requests.filter((request) => request.method === 'turn/interrupt'),
          ).toHaveLength(0);
          expect(
            events.filter((event) => event.kind === 'input-accepted'),
          ).toHaveLength(1);
          expect(
            events.every(
              (event) =>
                AgentSessionRuntimeEventSchema.safeParse(event).success,
            ),
          ).toBe(true);
          expect(JSON.stringify(events)).not.toContain('PRIVATE_');

          emitNotification('turn/completed', {
            threadId: 'fresh-thread',
            turn: { id: 'provider-turn-1', status: 'completed' },
          });
          await vi.waitFor(() =>
            expect(
              events.filter((event) => event.kind === 'turn-complete'),
            ).toHaveLength(1),
          );
          retry(connectionError);
          emitNotification('turn/completed', {
            threadId: 'fresh-thread',
            turn: { id: 'provider-turn-1', status: 'completed' },
          });
          await expect(
            session.send({
              inputIds: ['retry-next-input'],
              input: { text: 'Reply OK.' },
              delivery: { kind: 'newTurn', turnId: 'retry-next-turn' },
            }),
          ).resolves.toMatchObject({ status: 'admitted' });
          retry(connectionError, { turnId: 'provider-turn-2' });
          await vi.waitFor(() => expect(progress()).toHaveLength(attempts + 3));
          expect(progress().at(-1)).toMatchObject({
            turnId: 'retry-next-turn',
            retry: { attempt: 1, reason: 'connection_failed' },
          });
          await expect(
            session.cancel({ turnId: 'retry-next-turn' }),
          ).resolves.toMatchObject({ status: 'requested' });
          await vi.waitFor(() =>
            expect(
              events.filter((event) => event.kind === 'turn-cancelled'),
            ).toHaveLength(1),
          );
          expect(
            events.filter((event) => event.kind === 'turn-complete'),
          ).toHaveLength(1);
          expect(
            requests.filter((request) => request.method === 'turn/start'),
          ).toHaveLength(2);
        } finally {
          await session.dispose();
        }
      },
      { logger },
    );
  });

  it.each([
    {
      mode: 'default',
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite' },
    },
    {
      mode: 'plan',
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite' },
    },
    { mode: 'read-only', approvalPolicy: 'never', permissions: ':read-only' },
    {
      mode: 'safe-yolo',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite' },
    },
    {
      mode: 'yolo',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
    },
  ] as const)(
    'applies $mode at native create, every turn and resume',
    async (policy) => {
      await withFixture(
        async ({ openConfiguredSession, requests, emitNotification }) => {
          let session = await openConfiguredSession();
          const assertPolicy = (method: string) => {
            const params = requests.findLast(
              (request) => request.method === method,
            )?.params;
            if ('permissions' in policy)
              expect(params).toMatchObject({ permissions: policy.permissions, approvalPolicy: policy.approvalPolicy });
            else
              expect(params).toMatchObject({
                approvalPolicy: policy.approvalPolicy,
                ...(method === 'turn/start'
                  ? { sandboxPolicy: policy.sandboxPolicy }
                  : { sandbox: policy.sandbox }),
              });
          };
          assertPolicy('thread/start');
          for (const index of [1, 2, 3]) {
            const events: AgentSessionRuntimeEvent[] = [];
            const watch = session.watch((event) => events.push(event));
            await expect(
              session.send({
                inputIds: [`policy-input-${index}`],
                input: { text: 'Reply OK.' },
                delivery: { kind: 'newTurn', turnId: `policy-turn-${index}` },
              }),
            ).resolves.toMatchObject({ status: 'admitted' });
            assertPolicy('turn/start');
            emitNotification('turn/completed', {
              threadId: 'fresh-thread',
              turn: { id: `provider-turn-${index}`, status: 'completed' },
            });
            await vi.waitFor(() =>
              expect(events).toContainEqual(
                expect.objectContaining({
                  kind: 'turn-complete',
                  turnId: `policy-turn-${index}`,
                }),
              ),
            );
            watch.dispose();
            if (index === 2) {
              await session.dispose();
              session = await openConfiguredSession('fresh-thread');
              assertPolicy('thread/resume');
            }
          }
        },
        { permissionMode: policy.mode },
      );
    },
  );

  it('defers a read-only ceiling instead of steering into a running yolo turn', async () => {
    let activeNativeTurn: { threadId: unknown; turnId: string } | undefined;
    let nativeTurns = 0;
    await withFixture(async ({ openConfiguredSession, requests, directory, emitNotification }) => {
      let emitUserMessage: (message: UserMessage) => void = () => { throw new Error('Queue binding missing'); };
      // Only Home delivery/persistence and the native JSON-RPC peer are substituted.
      const session = createMutableApiSessionClientFixture({ sessionId: 'actual-happier-session', overrides: {
        onUserMessage(handler) { emitUserMessage = handler; },
        async reconcileSessionInputForProviderDispatch() { return 'admitted'; },
      } });
      const native = await openConfiguredSession();
      const host = createNativeAgentSessionInteractionOperations({ session: native, sessionId: session.sessionId, cwd: directory,
        context: { agent: { id: 'codex' } } as AgentSessionRuntimeContext,
        capabilities: { open: ['create'], delivery: ['newTurn', 'steer'], cancel: true, configuration: true },
        initialConfiguration: { mode: { value: null, updatedAtMs: 0 }, model: { value: 'fixture-model', updatedAtMs: 0 },
          permissionIntent: { value: 'yolo', updatedAtMs: 0 }, nativeSandbox: 'off', options: {} },
      });
      const permissionHandler = createProviderEnforcedPermissionHandler({ session, logPrefix: '[Steer ceiling]' });
      permissionHandler.setPermissionMode('yolo');
      const state = createPermissionModeQueueState({ session, agentTargetKey: 'codex', initialPermissionMode: 'yolo',
        inFlightSteer: {
          readActivePermissionMode: () => permissionHandler.getPermissionMode(),
          // The native peer is running its first turn and exposes turn/steer.
          isTurnInFlight: () => activeNativeTurn !== undefined,
          supportsInFlightSteer: () => true,
          steerText: (text, meta) => host.steerInFlightTurn(text, meta),
          readStructuredInputDispatchServices: () => ({
            reconcileSessionInputForProviderDispatch: input => session.reconcileSessionInputForProviderDispatch(input),
          }),
          registerProviderAcceptedEffect() {},
        },
      });
      host.beginTurnLifecycle();
      await host.sendTurnPrompt('YOLO_CONTROL', { localId: 'first' });
      expect(requests.find(request => request.method === 'turn/start')?.params).toMatchObject({ approvalPolicy: 'never' });
      emitUserMessage({ role: 'user', content: { type: 'text', text: 'WRITABLE_STEER_CONTROL' }, localId: 'control', meta: {} });
      await vi.waitFor(() => expect(requests.filter(request => request.method === 'turn/steer')).toHaveLength(1));
      const admitted = buildTrustedHostSessionInputAdmissionV1('ui');
      const authority = SessionInputAuthorityV1Schema.parse({ ...admitted.request,
        permission: { admittedPermissionCeiling: 'read-only' } });
      emitUserMessage({ role: 'user', content: { type: 'text', text: 'READ_ONLY_STEER' }, localId: 'lower',
        meta: { [SESSION_INPUT_AUTHORITY_META_KEY]: authority } });
      await vi.waitFor(() => expect(state.messageQueue.size() + requests.filter(request => request.method === 'turn/steer').length).toBe(2));
      expect(requests.filter(request => request.method === 'turn/steer')).toHaveLength(1);
      if (!activeNativeTurn) throw new Error('Missing native turn');
      emitNotification('turn/completed', { threadId: activeNativeTurn.threadId,
        turn: { id: activeNativeTurn.turnId, status: 'completed' } });
      await host.waitForTurnCompletion();
      let completed = false;
      await runPermissionModePromptLoop({ providerName: 'Codex', agentMessageType: 'codex', explicitPermissionMode: undefined,
        session, messageQueue: state.messageQueue, runtime: host, permissionHandler, messageBuffer: new MessageBuffer(),
        createOverrideSynchronizer: () => ({ syncFromMetadata() {}, async flushPendingAfterStart() {} }),
        shouldExit: () => completed, getAbortSignal: () => new AbortController().signal,
        keepAlive() {}, setThinking() {}, sendReady() { completed = true; },
        currentPermissionModeUpdatedAt: 0, setCurrentPermissionMode: state.setCurrentPermissionMode,
        setCurrentPermissionModeUpdatedAt: state.setCurrentPermissionModeUpdatedAt,
        formatPromptErrorMessage: String, registerProviderAcceptedEffect: () => undefined });
      expect(requests.filter(request => request.method === 'turn/start').map(request => request.params)).toMatchObject([
        { approvalPolicy: 'never' }, { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'dangerFullAccess' } },
      ]);
      expect(state.getCurrentPermissionMode()).toBe('yolo');
    }, { permissionMode: 'yolo', configuration: { nativeSandbox: 'off' },
      beforeTurnSteerResponse: ({ socket, params }) => {
        socket.send(JSON.stringify({ method: 'item/completed', params: {
          threadId: params.threadId, turnId: params.expectedTurnId,
          item: { id: `accepted-${params.clientUserMessageId}`, type: 'userMessage', clientId: params.clientUserMessageId, content: params.input },
        } }));
      },
      onTurnStart: ({ socket, params, turnId }) => {
        nativeTurns += 1;
        if (nativeTurns === 1) activeNativeTurn = { threadId: params.threadId, turnId };
        else socket.send(JSON.stringify({ method: 'turn/completed', params: {
          threadId: params.threadId, turn: { id: turnId, status: 'completed' },
        } }));
      },
    });
  });

  it.each([undefined, 'off'] as const)('dispatches causal read-only ceilings without reopening Codex with native sandbox %s', async (nativeSandbox) => {
    await withFixture(async ({ openConfiguredSession, requests, directory }) => {
      const native = await openConfiguredSession();
      let emitUserMessage: (message: UserMessage) => void = () => { throw new Error('Queue binding missing'); };
      const session = createMutableApiSessionClientFixture({ sessionId: 'actual-happier-session', overrides: {
        onUserMessage(handler) { emitUserMessage = handler; },
        async reconcileSessionInputForProviderDispatch() { return 'admitted'; },
      } });
      const host = createNativeAgentSessionInteractionOperations({
        session: native, sessionId: session.sessionId, cwd: directory,
        capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true, configuration: true },
        context: { agent: { id: 'codex' } } as AgentSessionRuntimeContext,
        initialConfiguration: {
          mode: { value: null, updatedAtMs: 0 }, model: { value: 'fixture-model', updatedAtMs: 0 },
          permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {},
          ...(nativeSandbox ? { nativeSandbox } : {}),
        },
      });
      // Only native JSON-RPC and host persistence are fixtures; the loop and adapter stay real.
      const state = createPermissionModeQueueState({ session, agentTargetKey: 'codex', initialPermissionMode: 'default' });
      const queue = state.messageQueue;
      for (const [index, entry] of ([
        { permissionMode: 'default' }, { permissionMode: 'default', ceiling: 'read-only' },
        { permissionMode: 'yolo' }, { permissionMode: 'yolo', ceiling: 'read-only' },
      ] as const).entries()) {
        const authority = 'ceiling' in entry ? SessionInputAuthorityV1Schema.parse({
          ...buildTrustedHostSessionInputAdmissionV1('ui').request,
          permission: { admittedPermissionCeiling: entry.ceiling },
        }) : undefined;
        emitUserMessage({ role: 'user', content: { type: 'text', text: 'Reply OK.' }, localId: `policy-${index}`,
          meta: { permissionMode: entry.permissionMode, ...(authority ? { [SESSION_INPUT_AUTHORITY_META_KEY]: authority } : {}) } });
      }
      let completed = 0;
      await runPermissionModePromptLoop({
        providerName: 'Codex', agentMessageType: 'codex', explicitPermissionMode: undefined,
        session, messageQueue: queue, runtime: host,
        permissionHandler: createProviderEnforcedPermissionHandler({ session, logPrefix: '[Causal policy]' }), messageBuffer: new MessageBuffer(),
        createOverrideSynchronizer: () => ({ syncFromMetadata() {}, async flushPendingAfterStart() {} }),
        shouldExit: () => completed === 4, getAbortSignal: () => new AbortController().signal,
        keepAlive() {}, setThinking() {}, sendReady: () => { completed += 1; },
        currentPermissionModeUpdatedAt: 0, setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {},
        formatPromptErrorMessage: String, registerProviderAcceptedEffect: () => undefined,
      });
      expect(requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
      expect(requests.filter(request => request.method === 'thread/resume')).toHaveLength(0);
      const readOnlyPolicy = nativeSandbox === 'off'
        ? { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'dangerFullAccess' } }
        : { approvalPolicy: 'never', permissions: ':read-only' };
      const turns = requests.filter(request => request.method === 'turn/start').map(request => request.params);
      expect(turns[0]).toMatchObject({ approvalPolicy: 'untrusted' });
      expect(turns).toMatchObject([
        { approvalPolicy: 'untrusted' },
        readOnlyPolicy,
        { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
        readOnlyPolicy,
      ]);
    }, { permissionMode: 'default', ...(nativeSandbox ? { configuration: { nativeSandbox } } : {}), onTurnStart: ({ socket, params, turnId }) => {
      socket.send(JSON.stringify({ method: 'turn/completed', params: {
        threadId: params.threadId, turn: { id: turnId, status: 'completed' },
      } }));
    } });
  });

  it.each(['session', 'run'] as const)(
    'honors admitted no-sandbox for read-only intent in a native %s',
    async (scope) => {
      await withFixture(async ({ openConfiguredSession, openConfiguredRun, requests }) => {
        const session = scope === 'session' ? await openConfiguredSession() : await openConfiguredRun();
        await session.send({
          inputIds: ['unsandboxed-read'],
          input: { text: 'Report the current directory.' },
          delivery: { kind: 'newTurn', turnId: 'unsandboxed-read-turn' },
        });
        expect(requests.find(request => request.method === 'thread/start')?.params).toMatchObject({
          approvalPolicy: 'untrusted', sandbox: 'danger-full-access',
        });
        const turn = requests.find(request => request.method === 'turn/start')?.params;
        expect(turn).toMatchObject({ approvalPolicy: 'untrusted', sandboxPolicy: { type: 'dangerFullAccess' } });
        expect(turn).not.toHaveProperty('permissions');
      }, { permissionMode: 'read-only', configuration: { nativeSandbox: 'off' } });
    },
  );

  it('replaces a retained read-only sandbox when the person selects yolo', async () => {
    await withFixture(async ({ openConfiguredSession, requests }) => {
      const session = await openConfiguredSession();
      await expect(
        session.updateConfiguration?.({
          mode: { value: null, updatedAtMs: 2 },
          model: { value: 'fixture-model', updatedAtMs: 2 },
          permissionIntent: { value: 'yolo', updatedAtMs: 2 },
          options: {},
        }),
      ).resolves.toMatchObject({ status: 'applied' });
      await expect(
        session.send({
          inputIds: ['relaxed-input'],
          input: { text: 'Reply OK.' },
          delivery: { kind: 'newTurn', turnId: 'relaxed-turn' },
        }),
      ).resolves.toMatchObject({ status: 'admitted' });
      expect(
        requests.findLast((request) => request.method === 'turn/start')?.params,
      ).toMatchObject({
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      });
    });
  });

  it('settles a flattened model_not_found before a second turn after direct native configuration', async () => {
    await withFixture(async ({ openConfiguredSession, emitNotification, requests, directory }) => {
      const session = await openConfiguredSession();
      const host = createNativeAgentSessionInteractionOperations({
        session, sessionId: 'actual-happier-session', cwd: directory,
        capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true, configuration: true },
        // Host services are unused by this input/lifecycle path; the native transport is real.
        context: { agent: { id: 'codex' } } as AgentSessionRuntimeContext,
      });
      const lifecycle = createSessionTurnLifecycle({
        agentId: 'codex',
        session: { sessionId: 'actual-happier-session', enqueueSessionTurnMutation: () => undefined },
      });
      const events: AgentSessionRuntimeEvent[] = [];
      const unsubscribe = host.subscribeRuntimeEvents(event => {
        events.push(AgentSessionRuntimeEventSchema.parse(event));
        lifecycle.observeRuntimeEvent(event);
      });
      await expect(
        host.sendTurnPrompt('Reply OK.', { localId: 'model-probe', turnId: 'model-probe-turn' }),
      ).resolves.toBeUndefined();
      expect(lifecycle.hasActiveTurn()).toBe(true);
      const failedCompletion = expect(host.waitForTurnCompletion()).rejects.toThrow(/model/i);
      emitNotification('turn/completed', {
        threadId: 'fresh-thread',
        turn: {
          id: 'provider-turn-1',
          status: 'failed',
          error: {
            codexErrorInfo: 'other',
            message: `HTTP 400: ${JSON.stringify({
              error: {
                type: 'invalid_request_error',
                code: 'model_not_found',
                param: null,
                message: 'PRIVATE_PROVIDER_BODY',
              },
            })}`,
          },
        },
      });
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: 'turn-failed',
            turnId: 'model-probe-turn',
            diagnostic: expect.objectContaining({
              code: 'provider_model_not_found',
              message: expect.stringMatching(/choose another model/i),
            }),
          }),
        ),
      );
      await failedCompletion;
      expect(lifecycle.hasActiveTurn()).toBe(false);
      expect(JSON.stringify(events)).not.toContain('PRIVATE_PROVIDER_BODY');
      await expect(session.cancel({ turnId: 'model-probe-turn' })).resolves.toMatchObject({ status: 'notRunning' });
      // Exercise the native adapter directly. The host's spawn-only model policy
      // still requires restart; the prompt-loop refusal test covers that policy.
      await expect(session.updateConfiguration?.({
        mode: { value: null, updatedAtMs: 2 },
        model: { value: 'valid-recovery-model', updatedAtMs: 2 },
        permissionIntent: { value: 'read-only', updatedAtMs: 2 },
        options: {},
      })).resolves.toMatchObject({ status: 'applied' });
      await expect(host.sendTurnPrompt('Reply OK.', {
        localId: 'model-recovery', turnId: 'model-recovery-turn',
      })).resolves.toBeUndefined();
      expect(lifecycle.hasActiveTurn()).toBe(true);
      expect(requests.findLast(request => request.method === 'turn/start')?.params).toMatchObject({ model: 'valid-recovery-model' });
      emitNotification('turn/completed', {
        threadId: 'fresh-thread',
        turn: { id: 'provider-turn-2', status: 'completed' },
      });
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        kind: 'turn-complete', turnId: 'model-recovery-turn',
      })));
      await expect(host.waitForTurnCompletion()).resolves.toBeUndefined();
      expect(lifecycle.hasActiveTurn()).toBe(false);
      unsubscribe();
      lifecycle.dispose();
      await host.resetOrDisposeRuntime();
    });
  });

  it('carries a ChatGPT-account model refusal as bounded model evidence that names the model', async () => {
    await withFixture(async ({ openConfiguredSession, emitNotification }) => {
      const session = await openConfiguredSession();
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch((event) =>
        events.push(AgentSessionRuntimeEventSchema.parse(event)),
      );
      await expect(
        session.send({
          inputIds: ['model-refusal'],
          input: { text: 'Reply OK.' },
          delivery: { kind: 'newTurn', turnId: 'model-refusal-turn' },
        }),
      ).resolves.toMatchObject({ status: 'admitted' });
      emitNotification('turn/completed', {
        threadId: 'fresh-thread',
        turn: {
          id: 'provider-turn-1',
          status: 'failed',
          error: {
            codexErrorInfo: 'other',
            message: `HTTP 400: ${JSON.stringify({
              error: {
                type: 'invalid_request_error',
                code: 'model_not_found',
                param: null,
                message:
                  "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
              },
            })}`,
          },
        },
      });
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: 'turn-failed',
            turnId: 'model-refusal-turn',
            diagnostic: expect.objectContaining({
              code: 'provider_model_not_found',
              message: expect.stringContaining("'gpt-6.1-sol'"),
              details: expect.objectContaining({
                runtimeAuthClassification: expect.objectContaining({
                  kind: 'plan',
                  limitCategory: 'plan_invalid',
                  quotaScope: 'model',
                  providerLimitId: 'gpt-6.1-sol',
                }),
              }),
            }),
          }),
        ),
      );
    });
  });

  it('maps startup instructions to native developerInstructions on create', async () => {
    await withFixture(
      async ({ openConfiguredSession, requests }) => {
        await openConfiguredSession();
        expect(
          requests.find((request) => request.method === 'thread/start')?.params,
        ).toMatchObject({
          developerInstructions: 'Global Voice developer instructions.',
        });
        expect(
          requests.some((request) => request.method === 'turn/start'),
        ).toBe(false);
      },
      {
        startupInstructions: {
          v: 1,
          id: 'happier.global_voice_agent',
          revision: 1,
          instructions: 'Global Voice developer instructions.',
        },
      },
    );
  });

  it('binds the host-frozen raw MCP configuration to the native thread, not the app-server launch', async () => {
    const mcpServers = Object.freeze({
      happier: Object.freeze({
        command: 'happier-mcp',
        args: Object.freeze(['serve']),
        env: Object.freeze({ HAPPIER_MCP_MODE: 'session' }),
      }),
    });
    const launches: Array<readonly string[]> = [];
    await withFixture(
      async ({ openConfiguredSession, requests }) => {
        await openConfiguredSession();
        expect(launches[0]?.join(' ')).not.toContain('mcp_servers.');
        const threadStart = requests.find((request) => request.method === 'thread/start')?.params;
        expect(threadStart?.config).toMatchObject({
          'mcp_servers.happier.command': 'happier-mcp',
          'mcp_servers.happier.args': ['serve'],
          'mcp_servers.happier.env': { HAPPIER_MCP_MODE: 'session' },
        });
        expect(threadStart).not.toHaveProperty('modelProvider');
      },
      {
        mcpServers,
        observer: {
          recordAppServerRequest() {},
          recordLaunch: (launch) => {
            launches.push(launch.argv);
          },
        },
      },
    );
  });

  it('uses canonical session authentication without a realtime API-key purpose or watcher', async () => {
    const connectedAccounts = {
      getBinding: vi.fn<ConnectedAccountsService['getBinding']>(
        async () => null,
      ),
      requestSelection: vi.fn<ConnectedAccountsService['requestSelection']>(),
      materialize: vi.fn<ConnectedAccountsService['materialize']>(),
      listAccounts: vi.fn<ConnectedAccountsService['listAccounts']>(),
      materializeListedAccount:
        vi.fn<ConnectedAccountsService['materializeListedAccount']>(),
      watch: vi.fn<ConnectedAccountsService['watch']>(() => ({ dispose() {} })),
    } satisfies ConnectedAccountsService;
    const launches: Array<
      Readonly<Record<string, string | undefined>> | undefined
    > = [];
    await withFixture(
      async ({ openConfiguredSession }) => {
        await openConfiguredSession();
        expect(
          connectedAccounts.getBinding.mock.calls.map(([purpose]) => purpose),
        ).not.toContain('realtime_upstream');
        expect(connectedAccounts.materialize).not.toHaveBeenCalled();
        expect(
          connectedAccounts.watch.mock.calls.map(([purpose]) => purpose),
        ).not.toContain('realtime_upstream');
        expect(launches.length).toBeGreaterThan(0);
        expect(launches.every((env) => env?.OPENAI_API_KEY === undefined)).toBe(
          true,
        );
      },
      {
        connectedAccounts,
        observer: {
          recordAppServerRequest() {},
          recordLaunch: (launch) => {
            launches.push(launch.env);
          },
        },
      },
    );
  });

  it('passes exact validated Provider engine configuration to the native app-server', async () => {
    const modelProvider = 'happier_0123456789abcdef0123456789abcdef';
    const engineConfig = Object.freeze({
      v: 1 as const,
      modelProvider,
      config: Object.freeze({
        [`model_providers.${modelProvider}`]: Object.freeze({
          name: 'Happier provider' as const,
          base_url: 'https://gateway.example.test/v1',
          wire_api: 'responses' as const,
          env_key: 'HAPPIER_CODEX_PROVIDER_API_KEY' as const,
          requires_openai_auth: false as const,
          supports_websockets: false as const,
        }),
      }),
    });
    await withFixture(
      async ({ openConfiguredSession, requests }) => {
        await openConfiguredSession();
        expect(
          requests.find((request) => request.method === 'thread/start')?.params,
        ).toMatchObject({
          model: 'gpt-5.6-luna',
          modelProvider,
          config: engineConfig.config,
        });
      },
      {
        providerBinding: {
          connectionId: 'pc_work',
          model: { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
          upstream: {
            protocol: 'openai-responses',
            normalizedUrl: 'https://gateway.example.test/v1',
            credential: 'apiKey',
          },
          materialization: { v: 1, kind: 'engineConfig', engineConfig },
        },
      },
    );
  });

  // These native fixtures consume resolved configuration without host admission.
  // Explicit undeclared effort is refused by the host; inherited/default values
  // can still reach this boundary and need the Provider's application fallback.
  it.each([
    { requested: 'medium', expected: 'low' },
    { requested: 'max', expected: 'max' },
  ])(
    'applies the Provider effort subset to resolved configuration updates ($requested)',
    async ({ requested, expected }) => {
      const engineConfig = {
        v: 1 as const,
        modelProvider: 'ollama',
        config: {},
      };
      await withFixture(
        async ({ openConfiguredSession, requests }) => {
          const session = await openConfiguredSession();
          await session.updateConfiguration?.({
            mode: { value: null, updatedAtMs: 1 },
            model: { value: 'fixture-model', updatedAtMs: 1 },
            permissionIntent: { value: 'read-only', updatedAtMs: 1 },
            options: { reasoning_effort: { value: requested, updatedAtMs: 2 } },
          });
          await session.send({
            inputIds: ['effort-input'],
            input: { text: 'Reply OK.' },
            delivery: { kind: 'newTurn', turnId: 'effort-turn' },
          });
          expect(
            requests.find((request) => request.method === 'turn/start')?.params,
          ).toMatchObject({ effort: expected });
        },
        {
          providerBinding: {
            connectionId: 'pc_work',
            model: {
              id: 'fixture-model',
              name: 'Fixture',
              capabilities: { reasoningControls: 'supported' },
              modelOptions: [
                {
                  id: 'reasoning_effort',
                  name: 'Thinking',
                  type: 'select',
                  currentValue: 'high',
                  options: [
                    { value: 'low', name: 'Low' },
                    { value: 'high', name: 'High' },
                    { value: 'max', name: 'Max' },
                  ],
                },
              ],
            },
            upstream: {
              protocol: 'openai-responses',
              normalizedUrl: 'https://gateway.example.test/v1',
              credential: 'apiKey',
            },
            materialization: { v: 1, kind: 'engineConfig', engineConfig },
          },
        },
      );
    },
  );

  it.each([
    { scope: 'session', requested: 'max', declared: true, expected: 'max' },
    { scope: 'run', requested: 'max', declared: true, expected: 'max' },
    {
      scope: 'session',
      requested: 'medium',
      declared: true,
      expected: undefined,
    },
    { scope: 'run', requested: 'medium', declared: true, expected: undefined },
    {
      scope: 'session',
      requested: 'high',
      declared: false,
      expected: undefined,
    },
    { scope: 'run', requested: 'high', declared: false, expected: undefined },
  ])(
    'applies declared effort and omits unsupported inherited effort at $scope startup ($requested, declared=$declared)',
    async ({ scope, requested, declared, expected }) => {
      await withFixture(
        async ({ openConfiguredSession, openConfiguredRun, requests }) => {
          const conversation =
            scope === 'session'
              ? await openConfiguredSession()
              : await openConfiguredRun();
          await conversation.send({
            inputIds: ['effort-input'],
            input: { text: 'Reply OK.' },
            delivery: { kind: 'newTurn', turnId: 'effort-turn' },
          });
          const thread = requests.find(
            (request) => request.method === 'thread/start',
          )?.params;
          const turn = requests.find(
            (request) => request.method === 'turn/start',
          )?.params;
          expect(turn).toHaveProperty('model', 'fixture-model');
          expect(turn?.effort).toBe(expected);
          expect(
            (thread?.config as Record<string, unknown> | undefined)
              ?.model_reasoning_effort,
          ).toBe(expected);
        },
        {
          configuration: {
            mode: { value: null, updatedAtMs: 1 },
            model: { value: 'stale-selected-model', updatedAtMs: 1 },
            permissionIntent: { value: 'read-only', updatedAtMs: 1 },
            options: { reasoning_effort: { value: requested, updatedAtMs: 1 } },
          },
          providerBinding: {
            connectionId: 'pc_work',
            model: {
              id: 'fixture-model',
              name: 'Fixture',
              capabilities: { reasoningControls: 'supported' },
              ...(declared
                ? {
                    modelOptions: [
                      {
                        id: 'reasoning_effort',
                        name: 'Thinking',
                        type: 'select',
                        currentValue: 'high',
                        options: [
                          { value: 'low', name: 'Low' },
                          { value: 'high', name: 'High' },
                          { value: 'max', name: 'Max' },
                        ],
                      },
                    ],
                  }
                : {}),
            },
            upstream: {
              protocol: 'openai-responses',
              normalizedUrl: 'https://gateway.example.test/v1',
              credential: 'apiKey',
            },
            materialization: {
              v: 1,
              kind: 'engineConfig',
              engineConfig: { v: 1, modelProvider: 'ollama', config: {} },
            },
          },
        },
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps the primary turn active when a completed execution run releases its process',
    async () => {
      const nativeTurns = new Map<
        string,
        { complete(): void; isOpen(): boolean }
      >();
      await withFixture(
        async ({
          openConfiguredSession,
          openConfiguredRun,
          endpoints,
          nativeProcessExits,
        }) => {
          const primary = await openConfiguredSession();
          const primaryEvents: AgentSessionRuntimeEvent[] = [];
          primary.watch((event) =>
            primaryEvents.push(AgentSessionRuntimeEventSchema.parse(event)),
          );
          await expect(
            primary.send({
              inputIds: ['primary-input'],
              input: { text: 'Keep working on the primary task.' },
              delivery: { kind: 'newTurn', turnId: 'primary-turn' },
            }),
          ).resolves.toMatchObject({ status: 'admitted' });

          const child = await openConfiguredRun();
          const childEvents: AgentExecutionRunConversationEventV1[] = [];
          child.watch((event) => childEvents.push(event));
          await expect(
            child.send({
              inputIds: ['child-input'],
              input: { text: 'Complete the delegated task.' },
              delivery: { kind: 'newTurn', turnId: 'child-turn' },
            }),
          ).resolves.toMatchObject({ status: 'admitted' });
          await vi.waitFor(() =>
            expect(nativeTurns.has('provider-turn-2')).toBe(true),
          );
          nativeTurns.get('provider-turn-2')!.complete();
          await vi.waitFor(() =>
            expect(childEvents).toContainEqual(
              expect.objectContaining({
                kind: 'turn-complete',
                turnId: 'child-turn',
              }),
            ),
          );
          await child.dispose();

          expect(endpoints).toHaveLength(2);
          expect(nativeProcessExits).toEqual([endpoints[1]]);
          expect(nativeTurns.get('provider-turn-1')?.isOpen()).toBe(true);
          expect(
            primaryEvents.some((event) => event.kind === 'turn-complete'),
          ).toBe(false);
          nativeTurns.get('provider-turn-1')!.complete();
          await vi.waitFor(() =>
            expect(primaryEvents).toContainEqual(
              expect.objectContaining({
                kind: 'turn-complete',
                turnId: 'primary-turn',
              }),
            ),
          );
          await expect(
            primary.send({
              inputIds: ['primary-followup'],
              input: { text: 'Continue after the child finished.' },
              delivery: { kind: 'newTurn', turnId: 'primary-followup-turn' },
            }),
          ).resolves.toMatchObject({ status: 'admitted' });
          expect(nativeProcessExits).toEqual([endpoints[1]]);
        },
        {
          onTurnStart: ({ socket, params, turnId }) => {
            // Deliver each native completion only to its process's connection.
            nativeTurns.set(turnId, {
              complete: () =>
                socket.send(
                  JSON.stringify({
                    method: 'turn/completed',
                    params: {
                      threadId: params.threadId,
                      turn: { id: turnId, status: 'completed' },
                    },
                  }),
                ),
              isOpen: () => socket.readyState === socket.OPEN,
            });
          },
        },
      );
    },
  );

  it('materializes the fresh native thread before any input even without startup instructions', async () => {
    await withFixture(
      async ({ openConfiguredSession, resume, requests }) => {
        const session = await openConfiguredSession();
        const events: AgentSessionRuntimeEvent[] = [];
        const subscription = session.watch((event) =>
          events.push(AgentSessionRuntimeEventSchema.parse(event)),
        );
        try {
          await expect(resume()).resolves.toMatchObject({
            thread: { id: 'fresh-thread', turns: [] },
          });
          expect(events).toContainEqual(
            expect.objectContaining({
              kind: 'provider-session-id',
              providerSessionId: 'fresh-thread',
            }),
          );
          expect(
            requests.some((request) => request.method === 'turn/start'),
          ).toBe(false);
        } finally {
          subscription.dispose();
        }
      },
      { startupInstructions: null },
    );
  });
  it('projects the c27 code-mode command once under its native command identity', async () => {
    await withFixture(async ({ runtime, emitNotification }) => {
      const native = createCodexNativeAppServerSessionRuntime(
        runtime,
        'actual-happier-session',
      );
      const events: AgentSessionRuntimeEvent[] = [];
      native.watch((event) =>
        events.push(AgentSessionRuntimeEventSchema.parse(event)),
      );
      try {
        await native.send({
          inputIds: ['pwd'],
          input: { text: 'Execute pwd' },
          delivery: { kind: 'newTurn', turnId: 'host-pwd' },
        });
        const scope = { threadId: 'fresh-thread', turnId: 'provider-turn-1' };
        // c27-history-settled.json seq6/7/11/12: outer code execution is
        // transport plumbing; the nested command has its own native identity.
        emitNotification('rawResponseItem/completed', {
          ...scope,
          item: {
            type: 'custom_tool_call',
            call_id: 'call-code',
            name: 'exec',
            input:
              'const r = await tools.exec_command({cmd:"pwd"}); text(r.output);',
          },
        });
        const command = {
          type: 'commandExecution',
          id: 'exec-command',
          command: '/bin/bash -lc pwd',
        };
        emitNotification('item/started', { ...scope, item: command });
        emitNotification('rawResponseItem/completed', {
          ...scope,
          item: {
            type: 'custom_tool_call_output',
            call_id: 'call-code',
            output: 'Script running with cell ID 1',
          },
        });
        emitNotification('item/completed', {
          ...scope,
          item: {
            ...command,
            status: 'completed',
            aggregatedOutput: '/workspace\n',
            exitCode: 0,
          },
        });
        emitNotification('turn/completed', {
          threadId: 'fresh-thread',
          turn: { id: scope.turnId, status: 'completed' },
        });
        await vi.waitFor(() =>
          expect(events.some((event) => event.kind === 'turn-complete')).toBe(
            true,
          ),
        );
        expect(events.filter((event) => event.kind === 'tool-call')).toEqual([
          expect.objectContaining({
            toolCallId: 'exec-command',
            toolName: 'Bash',
          }),
        ]);
        expect(events.filter((event) => event.kind === 'tool-result')).toEqual([
          expect.objectContaining({
            toolCallId: 'exec-command',
            output: expect.objectContaining({
              aggregatedOutput: '/workspace\n',
              exitCode: 0,
            }),
          }),
        ]);
        await native.send({
          inputIds: ['failed-script'],
          input: { text: 'Try another command' },
          delivery: { kind: 'newTurn', turnId: 'host-failed-script' },
        });
        const nextScope = {
          threadId: 'fresh-thread',
          turnId: 'provider-turn-2',
        };
        emitNotification('rawResponseItem/completed', {
          ...nextScope,
          item: {
            type: 'custom_tool_call',
            call_id: 'call-code',
            name: 'exec',
            input: 'await tools.exec_command({cmd:"pwd"});',
          },
        });
        emitNotification('rawResponseItem/completed', {
          ...nextScope,
          item: {
            type: 'custom_tool_call_output',
            call_id: 'call-code',
            output: 'Sandbox startup failed before a typed command existed',
          },
        });
        emitNotification('turn/completed', {
          threadId: 'fresh-thread',
          turn: { id: nextScope.turnId, status: 'completed' },
        });
        await vi.waitFor(() =>
          expect(
            events.filter((event) => event.kind === 'turn-complete'),
          ).toHaveLength(2),
        );
        expect(
          events.filter((event) => event.kind === 'tool-call'),
        ).toHaveLength(2);
        expect(
          events.filter((event) => event.kind === 'tool-result').at(-1),
        ).toMatchObject({
          toolCallId: 'call-code',
          output: 'Sandbox startup failed before a typed command existed',
        });
      } finally {
        await native.dispose();
      }
    });
  });
  it.skipIf(process.platform === 'win32')(
    'provides a supported runtime and product install remedy without disclosing native failure content',
    async () => {
      const sentinel = 'PRIVATE_NATIVE_RUNTIME_SENTINEL';
      await withFixture(
        async ({ openConfiguredSession }) => {
          const failure: unknown = await openConfiguredSession().then(
            () => null,
            (error) => error,
          );
          expect(failure).toMatchObject({
            code: 'codex_tool_restriction_unsupported_runtime',
          });
          if (!(failure instanceof Error))
            throw new Error('Expected a typed startup refusal');
          expect(failure.message).toContain('0.162.1');
          expect(failure.message).toContain('machines.agents.install');
          expect(failure.message).not.toContain(sentinel);
        },
        {
          nativeSpawnFailure: new PluginError({
            code: 'codex_tool_restriction_unsupported_runtime',
            message: sentinel,
          }),
          skills: {
            pluginRoot: '/fixture',
            skillsRoot: '/fixture/skills',
            items: [],
            nativeDisables: [],
          },
        },
      );
    },
  );
  it.skipIf(process.platform === 'win32').each([
    {
      scope: 'session',
      mode: 'read-only',
      sandbox: 'read-only',
      sandboxPolicy: { type: 'readOnly' },
    },
    {
      scope: 'run',
      mode: 'read-only',
      sandbox: 'read-only',
      sandboxPolicy: { type: 'readOnly' },
    },
    {
      scope: 'session',
      mode: 'yolo',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
    },
  ] as const)(
    'lets host-mediated MCP approval reach the host in a native $scope ($mode)',
    async ({ scope, mode, sandbox, sandboxPolicy }) => {
      await withFixture(
        async ({
          openConfiguredSession,
          openConfiguredRun,
          requests,
          emitNotification,
        }) => {
          const session =
            scope === 'session'
              ? await openConfiguredSession()
              : await openConfiguredRun();
          const sent = session.send({
            inputIds: ['mcp-read'],
            input: { text: 'Read the selected MCP tool.' },
            delivery: { kind: 'newTurn', turnId: 'mcp-read-turn' },
          });
          const approvalPolicy = {
            granular: {
              sandbox_approval: false,
              rules: false,
              mcp_elicitations: true,
              request_permissions: false,
              skill_approval: false,
            },
          };
          // Codex 0.162.1 rejects a prompted MCP tool before sending host input
          // when the thread uses `never` (including the :read-only profile).
          try {
            await vi.waitFor(() =>
              expect(
                requests.some((request) => request.method === 'turn/start'),
              ).toBe(true),
            );
            const thread = requests.find(
              (request) => request.method === 'thread/start',
            )?.params;
            expect(thread).toMatchObject({ approvalPolicy, sandbox });
            expect(thread).not.toHaveProperty('permissions');
            const turn = requests.find(
              (request) => request.method === 'turn/start',
            )?.params;
            expect(turn?.approvalPolicy).toEqual(approvalPolicy);
            expect(turn?.sandboxPolicy).toEqual(sandboxPolicy);
            expect(turn).not.toHaveProperty('permissions');
          } finally {
            emitNotification('turn/completed', {
              threadId: 'fresh-thread',
              turn: { id: 'provider-turn-1', status: 'completed' },
            });
            await sent;
          }
        },
        {
          permissionMode: mode,
          mcpServers: { docs: { command: 'fixture-bridge' } },
          mcpToolPolicy: { docs: { unlisted: 'deny', tools: { read: 'ask' } } },
        },
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'resumes the same persisted thread with a changed MCP launch set',
    async () => {
      await withFixture(
        async ({
          openConfiguredSession,
          requests,
          nativeLaunches,
          emitNotification,
        }) => {
          const initial = await openConfiguredSession();
          const events: AgentSessionRuntimeEvent[] = [];
          const subscription = initial.watch((event) => events.push(event));
          try {
            await initial.send({
              inputIds: ['before-restart'],
              input: { text: 'Remember the conversation.' },
              delivery: { kind: 'newTurn', turnId: 'host-turn-before' },
            });
            emitNotification('turn/completed', {
              threadId: 'fresh-thread',
              turn: { id: 'provider-turn-1', status: 'completed' },
            });
            await expect
              .poll(() =>
                events.some((event) => event.kind === 'turn-complete'),
              )
              .toBe(true);
            expect(events).toContainEqual(
              expect.objectContaining({
                kind: 'provider-session-id',
                providerSessionId: 'fresh-thread',
              }),
            );
          } finally {
            subscription.dispose();
            await initial.dispose();
          }

          const resumed = await openConfiguredSession('fresh-thread', {
            wilson: { command: 'fixture-bridge' },
          });
          expect(
            RuntimeDescriptorV1Schema.parse(resumed.runtimeDescriptorV1),
          ).toMatchObject({ agent: { providerSessionId: 'fresh-thread' } });
          expect(
            requests.filter((request) => request.method === 'thread/start'),
          ).toHaveLength(1);
          expect(
            requests
              .filter((request) => request.method === 'thread/resume')
              .map((request) => request.params.threadId),
          ).toEqual(['fresh-thread']);
          expect(nativeLaunches).toHaveLength(2);
          expect(nativeLaunches.flat().join(' ')).not.toContain('mcp_servers.');
          expect(
            requests.find((request) => request.method === 'thread/start')?.params.config,
          ).not.toHaveProperty('mcp_servers.happier__wilson.command');
          expect(
            requests.find((request) => request.method === 'thread/resume')?.params.config,
          ).toMatchObject({ 'mcp_servers.happier__wilson.command': 'fixture-bridge' });
          const resumedEvents: AgentSessionRuntimeEvent[] = [];
          const resumedSubscription = resumed.watch((event) =>
            resumedEvents.push(event),
          );
          try {
            await resumed.send({
              inputIds: ['after-restart'],
              input: { text: 'Continue our conversation.' },
              delivery: { kind: 'newTurn', turnId: 'host-turn-after' },
            });
            expect(
              requests
                .filter((request) => request.method === 'turn/start')
                .map((request) => request.params.threadId),
            ).toEqual(['fresh-thread', 'fresh-thread']);
            emitNotification('turn/completed', {
              threadId: 'fresh-thread',
              turn: { id: 'provider-turn-2', status: 'completed' },
            });
            await expect
              .poll(() =>
                resumedEvents.some(
                  (event) =>
                    event.kind === 'turn-complete' &&
                    event.turnId === 'host-turn-after',
                ),
              )
              .toBe(true);
          } finally {
            resumedSubscription.dispose();
          }
        },
      );
    },
  );

  it.skipIf(process.platform === 'win32').each(['session', 'run'] as const)(
    'retains the native permission cause through sanitized %s startup and public issue projection',
    async (scope) => {
      const logs: unknown[] = [];
      await withFixture(async ({ openConfiguredSession, openConfiguredRun }) => {
        const failure: unknown = await (scope === 'session' ? openConfiguredSession() : openConfiguredRun())
          .then(() => null, error => error);
        expect(failure).toMatchObject({ code: 'agent_startup_transport_failed', details: {
          failureCause: { code: 'EACCES', phase: 'client_start' },
        } });
        const retained = sanitizeNativeAgentSessionBoundaryError(failure, true);
        const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({
          cause: 'session_error', error: retained, provider: 'codex', occurredAt: 100,
        }));
        expect(issue.failureCause).toMatchObject({ code: 'EACCES', phase: 'client_start' });
        expect(logs).toContainEqual(expect.objectContaining({ failureCause: expect.objectContaining({ code: 'EACCES' }) }));
        expect(JSON.stringify([failure, retained, issue, logs])).not.toContain('PRIVATE_');
      }, {
        nativeSpawnFailure: Object.assign(new Error('Native spawn refused: api_key=PRIVATE_NATIVE_STDERR'), {
          code: 'EACCES', syscall: 'spawn /PRIVATE_BINARY', path: '/PRIVATE_HOME',
        }),
        logger: { debug: (_message, fields) => { logs.push(fields); }, warn: (_message, fields) => { logs.push(fields); } },
        skills: { pluginRoot: '/fixture', skillsRoot: '/fixture/skills', items: [], nativeDisables: [] },
      });
    },
  );

  it.skipIf(process.platform === 'win32').each(['session', 'run'] as const)(
    'diagnoses a native %s startup failure without exposing native error content',
    async (scope) => {
      const logs: unknown[] = [];
      const secret = 'PRIVATE_NATIVE_STARTUP_SENTINEL';
      const failure = Object.assign(
        new Error(secret, { cause: new Error(secret) }),
        {
          code: 'PLUGIN_EXEC_GENERATION_STALE',
          privatePayload: secret,
        },
      );
      await withFixture(
        async ({ openConfiguredSession, openConfiguredRun }) => {
          await expect(
            scope === 'session' ? openConfiguredSession() : openConfiguredRun(),
          ).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_GENERATION_STALE',
          });
          expect(logs).toContainEqual(
            expect.objectContaining({
              stage: 'skills',
              errorName: 'Error',
              errorCode: 'PLUGIN_EXEC_GENERATION_STALE',
              failureCause: expect.objectContaining({
                code: 'PLUGIN_EXEC_GENERATION_STALE',
                phase: 'client_start',
              }),
            }),
          );
          expect(JSON.stringify(logs)).not.toContain(secret);
        },
        {
          nativeSpawnFailure: failure,
          logger: {
            debug: (_message, fields) => {
              logs.push(fields);
            },
            warn: (_message, fields) => { logs.push(fields); },
          },
          skills: {
            pluginRoot: '/fixture',
            skillsRoot: '/fixture/skills',
            items: [],
            nativeDisables: [],
          },
        },
      );
    },
  );

  it.each(['assistant', 'reasoning'] as const)(
    'clears an existing %s draft with an empty normalized final without manufacturing empty output',
    async (channel) => {
      await withFixture(async ({ runtime, emitNotification }) => {
        await startCodexAppServerRuntime(runtime);
        const session = createCodexNativeAppServerSessionRuntime(
          runtime,
          'session-empty-final',
        );
        const events: AgentSessionRuntimeEvent[] = [];
        session.watch((event) => events.push(event));
        for (let turn = 1; turn <= 2; turn += 1) {
          const turnId = `empty-final-turn-${turn}`;
          const hasDraft = turn === 1;
          await session.send({
            inputIds: [`empty-input-${turn}`],
            input: { text: 'Use the final output' },
            delivery: { kind: 'newTurn', turnId },
          });
          if (hasDraft)
            emitNotification(
              channel === 'assistant'
                ? 'item/agentMessage/delta'
                : 'item/reasoning/textDelta',
              {
                threadId: 'fresh-thread',
                turnId: `provider-turn-${turn}`,
                itemId: 'removed',
                delta: 'Removed draft',
              },
            );
          emitNotification('item/completed', {
            threadId: 'fresh-thread',
            turnId: `provider-turn-${turn}`,
            item: {
              id: 'removed',
              type: channel === 'assistant' ? 'agentMessage' : 'reasoning',
              text: '',
            },
          });
          emitNotification('item/agentMessage/delta', {
            threadId: 'fresh-thread',
            turnId: `provider-turn-${turn}`,
            itemId: 'retained',
            delta: 'Retained answer',
          });
          emitNotification('item/completed', {
            threadId: 'fresh-thread',
            turnId: `provider-turn-${turn}`,
            item: {
              id: 'retained',
              type: 'agentMessage',
              text: 'Retained answer',
            },
          });
          emitNotification('turn/completed', {
            threadId: 'fresh-thread',
            turn: { id: `provider-turn-${turn}`, status: 'completed' },
          });
          await expect
            .poll(() =>
              events.some(
                (event) =>
                  event.kind === 'turn-complete' && event.turnId === turnId,
              ),
            )
            .toBe(true);
          const output = events.filter((event) => event.turnId === turnId);
          const snapshots = output.filter(
            (event) => event.kind === 'transcript-message-committed',
          );
          if (hasDraft) {
            const draft = output.find(
              (event) =>
                event.kind === 'message-delta' &&
                event.text === 'Removed draft',
            );
            expect(draft).toMatchObject({
              kind: 'message-delta',
              channel,
              messageId: expect.any(String),
            });
            if (draft?.kind !== 'message-delta' || !draft.messageId)
              throw new Error('Missing draft identity');
            expect(snapshots).toMatchObject([
              { role: channel, text: '', messageId: draft.messageId },
            ]);
            if (channel === 'assistant')
              expect(
                output.filter(
                  (event) =>
                    event.kind === 'message-delta' ||
                    event.kind === 'transcript-message-committed',
                ),
              ).toMatchObject([
                { kind: 'message-delta', text: 'Removed draft' },
                { kind: 'transcript-message-committed', text: '' },
                { kind: 'message-delta', text: 'Retained answer' },
              ]);
          } else {
            expect(snapshots).toEqual([]);
            expect(
              output
                .filter((event) => event.kind === 'message-delta')
                .map((event) => event.text),
            ).toEqual(['Retained answer']);
          }
          expect(output).toContainEqual(
            expect.objectContaining({
              kind: 'message-delta',
              channel: 'assistant',
              text: 'Retained answer',
            }),
          );
        }
      });
    },
  );

  it('correlates a corrected reasoning snapshot with its streamed segment', async () => {
    await withFixture(async ({ runtime, emitNotification }) => {
      await startCodexAppServerRuntime(runtime);
      const session = createCodexNativeAppServerSessionRuntime(
        runtime,
        'session-reasoning-replacement',
      );
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch((event) => events.push(event));
      await session.send({
        inputIds: ['reasoning-input'],
        input: { text: 'Think through the report' },
        delivery: { kind: 'newTurn', turnId: 'reasoning-turn' },
      });
      emitNotification('item/reasoning/textDelta', {
        threadId: 'fresh-thread',
        turnId: 'provider-turn-1',
        itemId: 'analysis',
        delta: 'Draft analysis',
      });
      emitNotification('item/completed', {
        threadId: 'fresh-thread',
        turnId: 'provider-turn-1',
        item: { id: 'analysis', type: 'reasoning', text: 'Corrected analysis' },
      });
      emitNotification('turn/completed', {
        threadId: 'fresh-thread',
        turn: { id: 'provider-turn-1', status: 'completed' },
      });
      await expect
        .poll(() => events.some((event) => event.kind === 'turn-complete'))
        .toBe(true);
      const delta = events.find((event) => event.kind === 'message-delta');
      expect(delta).toMatchObject({
        kind: 'message-delta',
        channel: 'reasoning',
        text: 'Draft analysis',
        messageId: expect.any(String),
      });
      if (delta?.kind !== 'message-delta' || !delta.messageId)
        throw new Error('Missing reasoning message identity');
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'transcript-message-committed',
          role: 'reasoning',
          text: 'Corrected analysis',
          messageId: delta.messageId,
          turnId: 'reasoning-turn',
        }),
      );
    });
  });

  it.each(['item/completed', 'rawResponseItem/completed'] as const)(
    'correlates corrected assistant snapshots with their streamed message and exact host turn (%s)',
    async (finalMethod) => {
      await withFixture(async ({ runtime, emitNotification }) => {
        await startCodexAppServerRuntime(runtime);
        const session = createCodexNativeAppServerSessionRuntime(
          runtime,
          'session-replacement',
        );
        const events: AgentSessionRuntimeEvent[] = [];
        session.watch((event) =>
          events.push(AgentSessionRuntimeEventSchema.parse(event)),
        );
        const messageIds: string[] = [];
        for (let turn = 1; turn <= 2; turn += 1) {
          const turnId = `host-turn-${turn}`;
          await session.send({
            inputIds: [`input-${turn}`],
            input: { text: 'Produce the final report' },
            delivery: { kind: 'newTurn', turnId },
          });
          emitNotification('item/agentMessage/delta', {
            threadId: 'fresh-thread',
            turnId: `provider-turn-${turn}`,
            itemId: 'report',
            delta: 'Draft report',
          });
          emitNotification(finalMethod, {
            threadId: 'fresh-thread',
            turnId: `provider-turn-${turn}`,
            item:
              finalMethod === 'item/completed'
                ? {
                    id: 'report',
                    type: 'agentMessage',
                    text: 'Corrected report',
                  }
                : {
                    id: 'report',
                    type: 'message',
                    role: 'assistant',
                    content: [
                      { type: 'output_text', text: 'Corrected report' },
                    ],
                  },
          });
          emitNotification('item/agentMessage/delta', {
            threadId: 'fresh-thread',
            turnId: `provider-turn-${turn}`,
            itemId: 'acknowledgment',
            delta: 'Artifact delivered.',
          });
          emitNotification('item/completed', {
            threadId: 'fresh-thread',
            turnId: `provider-turn-${turn}`,
            item: {
              id: 'acknowledgment',
              type: 'agentMessage',
              text: 'Artifact delivered.',
            },
          });
          emitNotification('turn/completed', {
            threadId: 'fresh-thread',
            turn: { id: `provider-turn-${turn}`, status: 'completed' },
          });
          await expect
            .poll(() =>
              events.some(
                (event) =>
                  event.kind === 'turn-complete' && event.turnId === turnId,
              ),
            )
            .toBe(true);
          const delta = events.find(
            (event) =>
              event.kind === 'message-delta' && event.turnId === turnId,
          );
          expect(delta).toMatchObject({
            kind: 'message-delta',
            channel: 'assistant',
            text: 'Draft report',
            messageId: expect.any(String),
          });
          if (delta?.kind !== 'message-delta' || !delta.messageId)
            throw new Error('Missing assistant message identity');
          messageIds.push(delta.messageId);
          expect(events).toContainEqual(
            expect.objectContaining({
              kind: 'transcript-message-committed',
              role: 'assistant',
              text: 'Corrected report',
              messageId: delta.messageId,
              turnId,
            }),
          );
          expect(
            events.filter(
              (event) =>
                event.turnId === turnId &&
                (event.kind === 'message-delta' ||
                  event.kind === 'transcript-message-committed'),
            ),
          ).toMatchObject([
            { kind: 'message-delta', text: 'Draft report' },
            { kind: 'transcript-message-committed', text: 'Corrected report' },
            { kind: 'message-delta', text: 'Artifact delivered.' },
          ]);
        }
        expect(messageIds[0]).not.toBe(messageIds[1]);
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'publishes native App Server mode on an ordinary fresh open',
    async () => {
      await withFixture(async ({ openConfiguredSession }) => {
        const session = await openConfiguredSession();
        expect(
          RuntimeDescriptorV1Schema.parse(session.runtimeDescriptorV1),
        ).toMatchObject({
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'appServer' },
        });
      });
    },
  );
  it.each(['provider', 'connectedAccount'] as const)(
    'opens a no-tools thread with %s auth despite an inherited MCP map',
    async (authority) => {
      const launches: Array<readonly string[]> = [];
      const authBytes = new TextEncoder().encode(
        JSON.stringify({
          auth_mode: 'chatgptAuthTokens',
          tokens: {
            access_token: 'fixture-access',
            account_id: 'fixture-account',
          },
        }),
      );
      await withFixture(
        async ({ runtime, requests }) => {
          await expect(runtime.prepareProviderCliAttach()).resolves.toBe(
            'fresh-thread',
          );
          expect(launches[0]).toEqual(
            expect.arrayContaining([
              'features.shell_tool=false',
              'features.view_image=false',
              'web_search="disabled"',
              'features.code_mode.excluded_tool_namespaces=["functions"]',
            ]),
          );
          expect(
            launches[0].some((value) => value.startsWith('mcp_servers.')),
          ).toBe(false);
          const thread = requests.find(
            (request) => request.method === 'thread/start',
          )?.params;
          expect([':read-only', 'read-only']).toContain(
            thread?.permissions ?? thread?.sandbox,
          );
          if (authority === 'connectedAccount') {
            expect(
              requests.find(
                (request) => request.method === 'account/login/start',
              )?.params,
            ).toMatchObject({
              type: 'chatgptAuthTokens',
              chatgptAccountId: 'fixture-account',
            });
          }
        },
        {
          ...(authority === 'provider'
            ? {
                initialProviderBinding: {
                  v: 1 as const,
                  modelProvider: 'ollama',
                  config: {},
                },
              }
            : {
                processEnv: {
                  HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
                    {
                      kind: 'profile',
                      serviceId: 'openai-codex',
                      profileId: 'fixture',
                    },
                  ]),
                },
                runtimeAuthHost: {
                  nativeHome: {
                    root: '/fixture',
                    readFiles: async () => ({ 'auth.json': authBytes }),
                  },
                  refreshRuntimeAuth: async () => ({
                    status: 'refreshed' as const,
                    result: {
                      accessToken: 'fixture-access',
                      providerAccountId: 'fixture-account',
                    },
                  }),
                },
              }),
          toolRestriction: { unlistedTools: 'deny', allowedTools: [] },
          mcpServers: {
            wilson: {
              command: 'fixture-bridge',
              enabledTools: ['allowed_echo'],
            },
          },
          // Native config and model catalog are independent process/network boundary evidence.
          nativeMcpServers: {},
          nativeToolMode: 'direct',
          observer: {
            recordAppServerRequest() {},
            recordLaunch: (launch) => {
              launches.push(launch.argv);
            },
          },
        },
      );
    },
  );
  it.skipIf(process.platform === 'win32')(
    'keeps a Connected Account no-tools Run confined through follow-up turns',
    async () => {
      const authBytes = new TextEncoder().encode(
        JSON.stringify({
          auth_mode: 'chatgptAuthTokens',
          tokens: {
            access_token: 'fixture-access',
            account_id: 'fixture-account',
          },
        }),
      );
      await withFixture(
        async ({
          openConfiguredRun,
          requests,
          nativeLaunches,
          emitNotification,
        }) => {
          const run = await openConfiguredRun();
          const events: AgentExecutionRunConversationEventV1[] = [];
          run.watch((event) => events.push(event));
          for (const [index, text] of [
            'Plain discussion answer',
            '{"summary":"Structured follow-up"}',
          ].entries()) {
            const turnId = `discussion-${index}`;
            await expect(
              run.send({
                inputIds: [turnId],
                input: { text: 'Discuss this stop.' },
                delivery: { kind: 'newTurn', turnId },
              }),
            ).resolves.toMatchObject({ status: 'admitted' });
            emitNotification('item/completed', {
              threadId: 'fresh-thread',
              turnId: `provider-turn-${index + 1}`,
              item: { id: `answer-${index}`, type: 'agentMessage', text },
            });
            emitNotification('turn/completed', {
              threadId: 'fresh-thread',
              turn: { id: `provider-turn-${index + 1}`, status: 'completed' },
            });
            await expect
              .poll(() =>
                events.some(
                  (event) =>
                    event.kind === 'turn-complete' && event.turnId === turnId,
                ),
              )
              .toBe(true);
            expect(events).toContainEqual(
              expect.objectContaining({ kind: 'message-delta', turnId, text }),
            );
          }
          expect(nativeLaunches[0]).toContain('features.shell_tool=false');
          expect(
            nativeLaunches[0].some((value) => value.startsWith('mcp_servers.')),
          ).toBe(false);
          expect(
            requests.find((request) => request.method === 'account/login/start')
              ?.params,
          ).toMatchObject({
            type: 'chatgptAuthTokens',
            chatgptAccountId: 'fixture-account',
          });
          expect(
            requests
              .filter((request) => request.method === 'turn/start')
              .map((request) => request.params.threadId),
          ).toEqual(['fresh-thread', 'fresh-thread']);
        },
        {
          toolRestriction: { unlistedTools: 'deny', allowedTools: [] },
          mcpServers: {
            wilson: {
              command: 'fixture-bridge',
              enabledTools: ['allowed_echo'],
            },
          },
          nativeMcpServers: {},
          nativeToolMode: 'direct',
          processEnv: {
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
              {
                kind: 'profile',
                serviceId: 'openai-codex',
                profileId: 'fixture',
              },
            ]),
          },
          runtimeAuthHost: {
            nativeHome: {
              root: '/fixture',
              readFiles: async () => ({ 'auth.json': authBytes }),
            },
            refreshRuntimeAuth: async () => ({
              status: 'refreshed',
              result: {
                accessToken: 'fixture-access',
                providerAccountId: 'fixture-account',
              },
            }),
          },
        },
      );
    },
  );
  it('rejects an MCP server the native process exposes despite the no-tools recipe', async () => {
    await withFixture(
      async ({ runtime, requests }) => {
        await expect(runtime.prepareProviderCliAttach()).rejects.toMatchObject({
          code: 'codex_tool_restriction_unsupported_runtime',
        });
        expect(
          requests.some((request) => request.method === 'thread/start'),
        ).toBe(false);
      },
      {
        toolRestriction: { unlistedTools: 'deny', allowedTools: [] },
        mcpServers: {
          wilson: { command: 'fixture-bridge', enabledTools: ['allowed_echo'] },
        },
        nativeMcpServers: { happier__wilson: { enabled: true } },
      },
    );
  });
  it('refuses a model catalog from another Provider authority before startup', async () => {
    await withFixture(
      async ({ runtime, requests }) => {
        await expect(runtime.prepareProviderCliAttach()).rejects.toMatchObject({
          code: 'codex_tool_restriction_unsupported_auth',
        });
        expect(
          requests.some((request) => request.method === 'thread/start'),
        ).toBe(false);
      },
      {
        initialProviderBinding: { v: 1, modelProvider: 'ollama', config: {} },
        toolRestriction: {
          unlistedTools: 'deny',
          allowedTools: ['mcp__wilson__allowed_echo'],
        },
        mcpServers: {
          wilson: { command: 'fixture-bridge', enabledTools: ['allowed_echo'] },
        },
      },
    );
  });
  it.each(['code_mode_only', 'direct'] as const)(
    'uses the materialized Connected Account catalog for a confined MCP launch (%s)',
    async (nativeToolMode) => {
      const authBytes = new TextEncoder().encode(
        JSON.stringify(
          buildCodexCloudAuthFile({
            accessToken: 'fixture-access',
            idToken: null,
            accountId: 'fixture-account',
            lastRefreshIso: '2026-10-26T00:00:00.000Z',
          }),
        ),
      );
      await withFixture(
        async ({ openConfiguredSession, requests }) => {
          if (nativeToolMode === 'direct') {
            await expect(openConfiguredSession()).rejects.toMatchObject({
              code: 'codex_tool_restriction_unsupported_model',
            });
            expect(
              requests.some((request) => request.method === 'turn/start'),
            ).toBe(false);
          } else {
            const session = await openConfiguredSession();
            await expect(
              session.send({
                inputIds: ['confined-connected-input'],
                input: { text: 'Use only the selected MCP tool.' },
                delivery: {
                  kind: 'newTurn',
                  turnId: 'confined-connected-turn',
                },
              }),
            ).resolves.toMatchObject({ status: 'admitted' });
            expect(
              requests.find(
                (request) => request.method === 'account/login/start',
              )?.params,
            ).toMatchObject({
              type: 'chatgptAuthTokens',
              chatgptAccountId: 'fixture-account',
            });
            expect(
              requests.some((request) => request.method === 'turn/start'),
            ).toBe(true);
          }
        },
        {
          nativeToolMode,
          processEnv: {
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
              {
                kind: 'profile',
                serviceId: 'openai-codex',
                profileId: 'fixture',
              },
            ]),
          },
          runtimeAuthHost: {
            nativeHome: { readFiles: async () => ({ 'auth.json': authBytes }) },
            refreshRuntimeAuth: async () => ({
              status: 'refreshed',
              result: {
                accessToken: 'fixture-access',
                providerAccountId: 'fixture-account',
              },
            }),
          },
          toolRestriction: {
            unlistedTools: 'deny',
            allowedTools: ['mcp__wilson__allowed_echo'],
          },
          mcpServers: {
            wilson: {
              command: 'fixture-bridge',
              enabledTools: ['allowed_echo'],
            },
          },
        },
      );
    },
  );
  it.each([
    { accountId: 'fixture-account', hasEvidence: true },
    { accountId: 'another-account', hasEvidence: true },
    { accountId: 'fixture-account', hasEvidence: false },
  ])(
    'applies external auth only with catalog evidence for that Account ($accountId, evidence=$hasEvidence)',
    async ({ accountId, hasEvidence }) => {
      const authBytes = new TextEncoder().encode(
        JSON.stringify(
          buildCodexCloudAuthFile({
            accessToken: 'fixture-access',
            idToken: null,
            accountId: 'fixture-account',
            lastRefreshIso: '2026-10-26T00:00:00.000Z',
          }),
        ),
      );
      await withFixture(
        async ({ runtime, requests }) => {
          const credential = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'openai-codex',
            profileId: 'fixture',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
              accessToken: 'fixture',
              refreshToken: 'fixture',
              idToken: 'fixture',
              scope: null,
              tokenType: null,
              providerAccountId: accountId,
              providerEmail: 'fixture@example.test',
            },
          });
          const apply = runtime.runtimeAuth.apply({
            serviceId: 'openai-codex',
            authGeneration: {
              credential: StrictJsonValueSchema.parse(credential),
            },
          });
          if (accountId === 'fixture-account' && hasEvidence) {
            await expect(apply).resolves.toMatchObject({
              ok: true,
              activeAccountId: accountId,
            });
            expect(
              requests.find(
                (request) => request.method === 'account/login/start',
              )?.params,
            ).toMatchObject({ chatgptAccountId: accountId });
          } else {
            await expect(apply).rejects.toMatchObject({
              code: 'codex_tool_restriction_unsupported_auth',
            });
            expect(
              requests.some(
                (request) => request.method === 'account/login/start',
              ),
            ).toBe(false);
          }
        },
        {
          runtimeAuthHost: {
            nativeHome: {
              readFiles: async () =>
                hasEvidence ? { 'auth.json': authBytes } : {},
            },
            refreshRuntimeAuth: async () => ({
              status: 'refreshed',
              result: {
                accessToken: 'fixture-access',
                providerAccountId: 'fixture-account',
              },
            }),
          },
          toolRestriction: {
            unlistedTools: 'deny',
            allowedTools: ['mcp__wilson__allowed_echo'],
          },
          mcpServers: {
            wilson: {
              command: 'fixture-bridge',
              enabledTools: ['allowed_echo'],
            },
          },
        },
      );
    },
  );
  it.skipIf(process.platform === 'win32')(
    'preserves the safe typed tool-policy refusal through native startup sanitization',
    async () => {
      await withFixture(
        async ({ openConfiguredSession }) => {
          await expect(openConfiguredSession()).rejects.toMatchObject({
            code: 'codex_tool_restriction_unsupported_model',
            message: expect.stringContaining(
              'codex_tool_restriction_unsupported_model',
            ),
          });
        },
        {
          nativeToolMode: 'direct',
          toolRestriction: {
            unlistedTools: 'deny',
            allowedTools: ['mcp__wilson__allowed_echo'],
          },
          mcpServers: {
            wilson: {
              command: 'fixture-bridge',
              enabledTools: ['allowed_echo'],
            },
          },
        },
      );
    },
  );
  it.skipIf(process.platform === 'win32')(
    'rejects a direct-tool model update before applying it to a confined MCP session',
    async () => {
      await withFixture(
        async ({ runtime, requests }) => {
          await expect(
            runtime.updateConfig?.({ modelId: 'direct-model' }),
          ).rejects.toMatchObject({
            code: 'codex_tool_restriction_unsupported_model',
          });
          expect(
            requests.some((request) => request.method === 'turn/start'),
          ).toBe(false);
        },
        {
          toolRestriction: {
            unlistedTools: 'deny',
            allowedTools: ['mcp__wilson__allowed_echo'],
          },
          mcpServers: {
            wilson: {
              command: 'fixture-bridge',
              enabledTools: ['allowed_echo'],
            },
          },
        },
      );
    },
  );
  it.skipIf(process.platform === 'win32')(
    'delivers the restricted MCP recipe to the thread without exposing credentials on shared server argv',
    async () => {
      await withFixture(
        async ({ exec, openConfiguredSession, nativeLaunches, requests }) => {
          const nativeProbe = vi.spyOn(exec, 'run');
          await openConfiguredSession();
          expect(nativeLaunches[0]?.join(' ')).not.toContain('fixture-mcp-bearer');
          const modelProbeArgs = nativeProbe.mock.calls.find(
            ([request]) => request.args[0] === 'debug' && request.args[1] === 'models',
          )?.[0].args;
          expect(modelProbeArgs).toContain('features.shell_tool=false');
          expect(modelProbeArgs?.join(' ')).not.toContain('fixture-mcp-bearer');
          expect(nativeLaunches[0]).toEqual(
            expect.arrayContaining([
              'features.shell_tool=false',
              'features.view_image=false',
              'web_search="disabled"',
            ]),
          );
          expect(requests.find(request => request.method === 'thread/start')?.params).toMatchObject({
            config: {
              'mcp_servers.happier__wilson.command': 'fixture-bridge',
              'mcp_servers.happier__wilson.args': ['fixture-mcp-bearer-arg'],
              'mcp_servers.happier__wilson.env': { SESSION_BEARER: 'fixture-mcp-bearer-env' },
              'mcp_servers.happier__wilson.enabled_tools': ['allowed_echo'],
              'mcp_servers.happier__wilson.default_tools_approval_mode': 'approve',
            },
          });
        },
        {
          toolRestriction: {
            unlistedTools: 'deny',
            allowedTools: ['mcp__wilson__allowed_echo'],
          },
          mcpServers: {
            wilson: {
              command: 'fixture-bridge',
              args: ['fixture-mcp-bearer-arg'],
              env: { SESSION_BEARER: 'fixture-mcp-bearer-env' },
              enabledTools: ['allowed_echo'],
            },
          },
        },
      );
    },
  );
  it('retains confinement when a live configuration update requests unrestricted native permissions', async () => {
    await withFixture(
      async ({ runtime, requests }) => {
        await runtime.updateConfig?.({ permissionMode: 'yolo' });
        await runtime.prepareProviderCliAttach();
        const nativePolicy = requests.find(
          (request) => request.method === 'thread/start',
        )?.params;
        expect([':read-only', 'read-only']).toContain(
          nativePolicy?.permissions ?? nativePolicy?.sandbox,
        );
        if (!nativePolicy?.permissions)
          expect(nativePolicy?.approvalPolicy).toBe('never');
      },
      { toolRestriction: { unlistedTools: 'deny', allowedTools: [] } },
    );
  });
  it.skipIf(process.platform === 'win32')(
    'starts through native control with a long host temporary directory',
    async () => {
      await withFixture(
        async ({ openConfiguredSession }) => {
          const session = await openConfiguredSession();
          const presentation = await session.prepareTerminalPresentation?.();
          expect(presentation).toMatchObject({
            kind: 'provider_attach',
            metadata: {
              runtimeDescriptorV1: {
                agent: { providerSessionId: 'fresh-thread' },
              },
            },
          });
        },
        { longTemporaryDirectory: true },
      );
    },
  );
  it.skipIf(process.platform === 'win32')(
    'keeps the startup preview static while redacting retained provider detail',
    async () => {
      await withFixture(async ({ openConfiguredSession, failResume }) => {
        failResume(
          'provider refused startup: Bearer private-startup-token /private/config',
        );
        const error = await openConfiguredSession('existing-thread').catch(
          (failure: unknown) => failure,
        );
        expect(error).toMatchObject({
          code: 'agent_startup_rpc_rejected',
          details: { failureCause: {
            phase: 'thread_open',
            providerErrorMessage: expect.stringContaining('Bearer [REDACTED]'),
          } },
        });
        expect(String(error)).not.toContain('private-startup-token');
        expect(String(error)).not.toContain('/private/config');
        expect(JSON.stringify(error)).not.toContain('private-startup-token');
      });
    },
  );
  it.each([
    [
      'no rollout found for thread id missing-thread',
      'AGENT_RESUME_PROVIDER_STATE_MISSING',
    ],
    ['provider temporarily unavailable', undefined],
  ])(
    'classifies resume rejection %s without starting a replacement thread',
    async (message, code) => {
      await withFixture(async ({ runtime, requests, failResume }) => {
        failResume(message);
        const error = await startCodexAppServerRuntime(runtime, {
          resumeId: 'missing-thread',
          preserveRequestedThreadId: true,
        }).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error & { code?: unknown }).code).toBe(code ?? -32000);
        if (code) expect(error).toMatchObject({ cause: expect.objectContaining({ code: -32000 }),
          failureCause: expect.objectContaining({ phase: 'thread_open', actionCause: expect.objectContaining({ errorCode: '-32000' }) }) });
        expect(
          requests
            .filter((request) => request.method === 'thread/resume')
            .map((request) => request.params.threadId),
        ).toEqual(['missing-thread']);
        expect(
          requests.some((request) => request.method === 'thread/start'),
        ).toBe(false);
      });
    },
  );
  it.skipIf(process.platform === 'win32')(
    'preserves the typed missing-state reason through native session startup sanitization',
    async () => {
      const logs: unknown[] = [];
      await withFixture(
        async ({ openConfiguredSession, requests, failResume }) => {
          failResume('no rollout found for thread id missing-thread');
          const error = await openConfiguredSession('missing-thread').catch(
            (failure: unknown) => failure,
          );
          expect(error).toMatchObject({
            code: 'AGENT_RESUME_PROVIDER_STATE_MISSING',
            details: { failureCause: expect.objectContaining({ phase: 'thread_open', actionCause: expect.objectContaining({ errorCode: '-32000' }) }) },
          });
          expect(logs).toContainEqual(
            expect.objectContaining({
              stage: 'native_session',
              errorName: 'Error',
              errorCode: 'AGENT_RESUME_PROVIDER_STATE_MISSING',
            }),
          );
          expect(
            requests
              .filter((request) => request.method === 'thread/resume')
              .map((request) => request.params.threadId),
          ).toEqual(['missing-thread']);
          expect(
            requests.some((request) => request.method === 'thread/start'),
          ).toBe(false);
        },
        {
          logger: {
            debug: (_message, fields) => {
              logs.push(fields);
            },
            warn: (_message, fields) => { logs.push(fields); },
          },
        },
      );
    },
  );
  it.skipIf(process.platform === 'win32')(
    'applies initial canonical effort before startup instructions initialize the native attachment thread',
    async () => {
      await withFixture(async ({ openConfiguredSession, requests }) => {
        const session = await openConfiguredSession();
        await session.prepareTerminalPresentation?.();
        expect(
          requests.find((r) => r.method === 'thread/start')?.params,
        ).toMatchObject({
          model: 'fixture-model',
          permissions: ':read-only',
          config: { model_reasoning_effort: 'low' },
          developerInstructions: 'Actual startup instructions.',
        });
        expect(
          requests.filter((r) => r.method === 'thread/start'),
        ).toHaveLength(1);
        expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
      });
    },
  );
  it('materializes zero-turn fresh threads once and preserves identity and policy on repeat attach', async () => {
    await withFixture(async ({ runtime, requests, resume }) => {
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe(
        'fresh-thread',
      );
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe(
        'fresh-thread',
      );
      expect(runtime.identity.read()).toEqual({
        providerSessionId: 'fresh-thread',
      });
      await expect(resume()).resolves.toMatchObject({
        thread: { id: 'fresh-thread', turns: [] },
        sandbox: { type: 'readOnly' },
        reasoningEffort: 'low',
      });
      await expect(resume()).resolves.toMatchObject({
        thread: { id: 'fresh-thread', turns: [] },
      });
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(
        1,
      );
      expect(requests.filter((r) => r.method === 'thread/name/set')).toEqual([
        {
          method: 'thread/name/set',
          params: {
            threadId: 'fresh-thread',
            name: 'Happier session actual-happier-session',
          },
        },
      ]);
      expect(requests.filter((r) => r.method === 'thread/read')).toEqual([
        {
          method: 'thread/read',
          params: { threadId: 'fresh-thread', includeTurns: true },
        },
      ]);
      expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
      expect(
        requests.find((r) => r.method === 'thread/start')?.params,
      ).toMatchObject({
        permissions: ':read-only',
        config: { model_reasoning_effort: 'low' },
      });
      await runtime.updateConfig?.({ modelId: 'later-model' });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe(
        'fresh-thread',
      );
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(
        1,
      );
      await runtime.updateConfig?.({ permissionMode: 'acceptEdits' });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe(
        'fresh-thread',
      );
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(
        1,
      );
    });
  });

  it('keeps an existing resumed thread name and does not initialize a new thread', async () => {
    await withFixture(async ({ runtime, requests }) => {
      await startCodexAppServerRuntime(runtime, {
        resumeId: 'existing-thread',
        importHistory: false,
      });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe(
        'existing-thread',
      );
      expect(
        requests.filter((r) =>
          [
            'thread/start',
            'thread/name/set',
            'thread/read',
            'turn/start',
          ].includes(r.method),
        ),
      ).toEqual([]);
    });
  });

  it('keeps a realtime zero-turn identity provisional until native rollout materialization', async () => {
    await withFixture(async ({ runtime, requests, resume }) => {
      await startCodexAppServerRuntime(runtime);
      const started = await runtime.realtimeConversation.start({
        transport: { kind: 'webrtc', offerSdp: 'offer' },
      });
      expect(started.status).toBe('started');
      if (started.status !== 'started')
        throw new Error('Realtime fixture failed to start');
      expect(runtime.identity.read()).toEqual({ providerSessionId: null });
      await expect(resume()).rejects.toThrow('no rollout found');

      await expect(runtime.prepareProviderCliAttach()).resolves.toBe(
        'fresh-thread',
      );
      expect(runtime.identity.read()).toEqual({
        providerSessionId: 'fresh-thread',
      });
      await expect(resume()).resolves.toMatchObject({
        thread: { id: 'fresh-thread', turns: [] },
      });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe(
        'fresh-thread',
      );
      await expect(resume()).resolves.toMatchObject({
        thread: { id: 'fresh-thread', turns: [] },
      });
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(
        1,
      );
      expect(
        requests.filter((r) => r.method === 'thread/name/set'),
      ).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/read')).toHaveLength(
        1,
      );
      expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
      await started.handle.stop();
      await runtime.updateConfig?.({ modelId: 'later-model' });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe(
        'fresh-thread',
      );
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(
        1,
      );
      expect(requests.filter((r) => r.method === 'thread/read')).toHaveLength(
        1,
      );
    });
  });

  it('withholds attachment identity if the fresh rollout cannot be materialized', async () => {
    await withFixture(async ({ runtime, failRead }) => {
      failRead();
      await expect(runtime.prepareProviderCliAttach()).rejects.toThrow(
        'rollout persistence failed',
      );
      expect(runtime.identity.read()).toEqual({ providerSessionId: null });
    });
  });
});
