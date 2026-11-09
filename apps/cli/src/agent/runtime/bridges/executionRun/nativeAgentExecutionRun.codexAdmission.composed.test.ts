import { describe, expect, it, vi } from 'vitest';
import type { AgentExecutionRunEvent, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createExecutionRunHostBackendFromSessionRuntime } from './sessionAdapter';
import { createAgentSessionTurnInvariant } from '@/agent/runtime/session/turn/agentSessionTurnInvariant';
import { createCodexNativeAppServerSessionRuntime } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/native.js';
import { withCodexNativeAttachFixture, codexNativePreparationFailureCases, codexNativeRetryProviderBinding } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support.js';
import { createCodexAgentRuntime } from '../../../../../../../packages/plugins/codex/src/agent/runtime/engine.js';
import { createVoiceSessionContextLease } from '@/agent/runtime/bridges/executionRun/testkit/nativeSessionContext';
import { createNativeAgentSessionExecutionRunHostRuntime, createNativeAgentSessionInteractionHostRuntime,
  type NativeAgentSessionContextLeaseFactory } from '@/agent/runtime/bridges/executionRun/nativeAgentExecutionRun';
import { createLazyExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/hostRuntime/lazy';
import { withExecutionRunHostRuntimeCleanup } from '@/agent/runtime/bridges/executionRun/hostRuntime/cleanup';
import { CODEX_PREFLIGHT_SESSION_CONTROLS } from '@happier-dev/plugins-codex/agent/lifecycle/preflight/sessionControls';
import { createExecutionRunDiagnosticError, projectExecutionRunError, readExecutionRunErrorCode } from '@/agent/runtime/bridges/executionRun/errors';

// Isolate only the OS-user startup lock; the client, native admission and host
// lifecycle owners execute against the fixture's real JSON-RPC socket.
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: process.env.TMPDIR || actual.userInfo().homedir }) };
});

describe('native start admission through the host Run adapter', () => {
  it.each([
    { adapter: 'finite', kind: 'create' }, { adapter: 'finite', kind: 'resume' },
    { adapter: 'retained', kind: 'create' }, { adapter: 'retained', kind: 'resume' },
  ] as const)('bounds custom Provider retries through the $adapter Session-owned Run entry ($kind)', async ({ adapter, kind }) => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const modelProvider = 'happier_0123456789abcdef0123456789abcdef';
    const providerBinding = codexNativeRetryProviderBinding();
    await withCodexNativeAttachFixture(async ({ runtime: seed, exec, launchEnvironment, directory, requests, emitNotification }) => {
      if (kind === 'resume') await seed.prepareProviderCliAttach();
      const controller = new AbortController();
      const runtime = await createCodexAgentRuntime({ plugin: { id: 'happier.agent.codex', version: '0.0.0' },
        agent: { id: 'codex' }, signal: controller.signal });
      const createSessionContext: NativeAgentSessionContextLeaseFactory = ({ services, signal }) =>
        createVoiceSessionContextLease({ services: { ...services, exec, logger: {
          ...logger, info() {}, error() {},
        } }, signal, async dispose() {} });
      const runId = `custom-retry-${adapter}-${kind}`;
      const common = { runtime, createSessionContext, generationSignal: controller.signal,
        lease: { pluginId: 'happier.agent.codex', pluginVersion: '0.0.0', agentId: 'codex', localAgentId: 'codex',
          occurrenceId: runId, isCurrent: () => true },
        options: { cwd: directory, runId, scope: 'session_owned' as const, backendId: 'codex',
          permissionMode: 'read_only', isolation: { env: launchEnvironment.values }, providerBinding,
          configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: 'gpt-5', updatedAtMs: 1 },
            permissionIntent: { value: 'read-only' as const, updatedAtMs: 1 }, options: {} },
          start: { intent: 'delegate' as const, runClass: 'bounded' as const,
            retentionPolicy: 'resumable' as const } },
      };
      const host = adapter === 'finite'
        ? createNativeAgentSessionExecutionRunHostRuntime({ ...common, supportsResume: true })
        : createNativeAgentSessionInteractionHostRuntime({ ...common,
          sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } });
      try {
        const { runtimeId } = await host.provisionRuntime(kind === 'resume' ? { resumeRuntimeId: 'fresh-thread' } : undefined);
        await expect(host.deliverInput(runtimeId, { text: 'Reply OK.' })).resolves.toMatchObject({ status: 'admitted' });
        const method = kind === 'resume' ? 'thread/resume' : 'thread/start';
        expect(requests.findLast(request => request.method === method)?.params).toMatchObject({
          modelProvider, config: { ...providerBinding.materialization.engineConfig.config,
            'features.unbounded_connection_retries': false },
        });
        expect(logger.debug).toHaveBeenCalledWith('Codex app-server thread retry policy', {
          method, isExecutionRun: true, hasUnboundedConnectionRetriesOverride: true, unboundedConnectionRetries: false,
        });
        const error = { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } }, message: 'Connection failed' };
        emitNotification('error', { threadId: 'fresh-thread', turnId: 'turn-1', willRetry: true, error });
        await vi.waitFor(() => expect(logger.debug).toHaveBeenCalledWith(
          'Codex app-server awaiting terminal notification after provider error', expect.objectContaining({ willRetry: true }),
        ));
        expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
        expect(requests.filter(request => request.method === 'turn/interrupt')).toHaveLength(0);
        const completion = host.waitForTurnCompletion();
        const failure = expect(completion).rejects.toBeInstanceOf(Error);
        emitNotification('turn/completed', { threadId: 'fresh-thread', turn: { id: 'turn-1', status: 'failed', error } });
        await failure;
        expect(logger.debug.mock.calls.filter(([message]) => message === 'Codex app-server thread retry policy'))
          .toHaveLength(requests.filter(request => request.method === 'thread/start' || request.method === 'thread/resume').length);
      } finally { await host.dispose(); controller.abort(); }
    }, { logger, turnIdForStart: () => 'turn-1' });
  });

  it.each(codexNativePreparationFailureCases())('retains the cause of $title before dispatch through the Session and public Run', async ({ phase, code, retryable, options }) => {
    const warnings: unknown[] = [];
    await withCodexNativeAttachFixture(async ({ runtime, requests, directory }) => {
      const session = createCodexNativeAppServerSessionRuntime(runtime, 'actual-happier-session');
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch(event => events.push(event));
      const run = await createExecutionRunHostBackendFromSessionRuntime({
        request: { kind: 'resume', runId: 'preparation-cause-run', cwd: directory,
          profile: { pluginId: 'happier.agent.codex', localId: 'codex' }, checkpointId: 'fresh-thread' },
        sessionId: 'actual-happier-session', openSession: () => session,
      });
      try {
        const result = await run.send({ text: 'PRIVATE_PROMPT' }, { localInputId: 'preparation-input' });
        expect(result).toMatchObject({ status: 'rejected', diagnostic: {
          code, details: { failureCause: { phase } },
        } });
        if ('initializeFailure' in options) expect(result).toMatchObject({ diagnostic: {
          details: { failureCause: { providerErrorCode: options.initializeFailure.code } },
        } });
        const rejected = events.filter(event => event.kind === 'input-rejected');
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toMatchObject({ retryable });
        expect(events.filter(event => ['turn-start', 'turn-failed', 'input-custody-unknown'].includes(event.kind))).toHaveLength(0);
        if (!result.diagnostic) throw new Error('Missing preparation diagnostic');
        const publicError = projectExecutionRunError(createExecutionRunDiagnosticError(result.diagnostic, 1, 'codex'));
        expect(publicError).toMatchObject({ code, runtimeIssueV1: { code, failureCause: { phase } } });
        expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(0);
        expect(warnings).toHaveLength(1);
        expect(JSON.stringify([events, publicError, warnings])).not.toContain('PRIVATE_');
      } finally { await run.dispose(); }
    }, { ...options, logger: { debug() {}, warn: (...args) => { warnings.push(args); } } });
  });

  it('carries a native HTTP 401 through the Session issue and public Run error without retrying', async () => {
    await withCodexNativeAttachFixture(async ({ openConfiguredSession, emitNotification, requests, directory }) => {
      const runtime = await openConfiguredSession();
      const failed = new Promise<Extract<AgentSessionRuntimeEvent, { kind: 'turn-failed' }>>(resolve => {
        runtime.watch(event => { if (event.kind === 'turn-failed') resolve(event); });
      });
      const run = await createExecutionRunHostBackendFromSessionRuntime({
        request: { kind: 'resume', runId: 'native-auth-run', cwd: directory,
          profile: { pluginId: 'happier.agent.codex', localId: 'codex' }, checkpointId: 'fresh-thread' },
        sessionId: 'actual-happier-session', openSession: () => runtime,
      });
      const runFailed = new Promise<Extract<AgentExecutionRunEvent, { kind: 'run-failed' }>>(resolve => {
        run.watch(event => { if (event.kind === 'run-failed') resolve(event); });
      });
      await expect(run.send({ text: 'hello' }, { localInputId: 'native-auth-input' }))
        .resolves.toMatchObject({ status: 'admitted' });
      const turnStart = requests.find(request => request.method === 'turn/start');
      emitNotification('turn/completed', { threadId: turnStart?.params.threadId, turn: {
        id: 'turn-1', status: 'failed', error: {
          message: 'Missing bearer or basic authentication in header. PRIVATE_BODY',
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
        },
      } });
      const event = await failed;
      expect(event.diagnostic).toMatchObject({ code: 'provider_endpoint_auth_required',
        message: 'Sign in to Codex or choose a Codex account.', details: { source: 'auth_error',
          failureCause: { phase: 'turn', failureReason: 'authentication_required', httpStatus: 401 } } });
      const runEvent = await runFailed;
      expect(runEvent.diagnostic).toMatchObject({ code: 'provider_endpoint_auth_required' });
      const publicError = projectExecutionRunError(createExecutionRunDiagnosticError(runEvent.diagnostic, 1, 'codex'));
      expect(publicError).toMatchObject({ code: 'provider_endpoint_auth_required', runtimeIssueV1: {
        code: 'provider_endpoint_auth_required', source: 'auth_error',
        failureCause: { phase: 'turn', failureReason: 'authentication_required', httpStatus: 401 },
      } });
      expect(JSON.stringify(publicError)).not.toContain('PRIVATE_');
      expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
      await run.dispose();
    }, { turnIdForStart: () => 'turn-1' });
  });
  it.each(['finite', 'retained'] as const)('reports the prepared %s Run prefix reservation at the provider scalar boundary', async kind => {
    const readMaxInputUnicodeCharacters = () => CODEX_PREFLIGHT_SESSION_CONTROLS.resolveMaxInputUnicodeCharacters({ accountSettings: null });
    const limit = readMaxInputUnicodeCharacters();
    if (limit === null) throw new Error('Native Codex input capacity is unavailable');
    const skillIndex = 'Available Run skills: 🧭 review';
    const prefixCharacters = Array.from(skillIndex).length + 2;
    for (const overflow of [0, 1]) {
      await withCodexNativeAttachFixture(async ({ exec, launchEnvironment, directory, requests }) => {
        const controller = new AbortController();
        const runtime = await createCodexAgentRuntime({ plugin: { id: 'happier.agent.codex', version: '0.0.0' },
          agent: { id: 'codex' }, signal: controller.signal });
        let contextPreparations = 0;
        const createSessionContext: NativeAgentSessionContextLeaseFactory = ({ services, signal }) => {
          contextPreparations += 1;
          // Substitute process and log sinks; the host, Codex runtime and codec stay real.
          const lease = createVoiceSessionContextLease({ services: { ...services, exec,
            logger: { debug() {}, info() {}, warn() {}, error() {} } }, signal, async dispose() {} });
          return { ...lease, skillIndex };
        };
        const common = { runtime, createSessionContext, readMaxInputUnicodeCharacters, generationSignal: controller.signal,
          lease: { pluginId: 'happier.agent.codex', pluginVersion: '0.0.0', agentId: 'codex', localAgentId: 'codex',
            occurrenceId: `budget-${kind}-${overflow}`, isCurrent: () => true },
          options: { cwd: directory, runId: `budget-${kind}-${overflow}`, scope: 'session_owned' as const, backendId: 'codex',
            permissionMode: 'read_only', isolation: { env: launchEnvironment.values },
            configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: 'fixture-model', updatedAtMs: 1 },
              permissionIntent: { value: 'read-only' as const, updatedAtMs: 1 }, options: {} },
            start: { intent: 'review' as const, runClass: kind === 'finite' ? 'bounded' as const : 'long_lived' as const,
              retentionPolicy: 'resumable' as const } },
        };
        const nativeHost = kind === 'finite' ? createNativeAgentSessionExecutionRunHostRuntime({ ...common, supportsResume: true })
          : createNativeAgentSessionInteractionHostRuntime({ ...common,
            sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } });
        const host = createLazyExecutionRunHostRuntime({ resolveRuntime: async () =>
          withExecutionRunHostRuntimeCleanup(nativeHost, async () => {}) });
        try {
          expect(host.prepareInputBudget).toBeTypeOf('function');
          const budget = await host.prepareInputBudget!();
          expect(budget).toBe(limit - prefixCharacters);
          if (budget === undefined) throw new Error('Prepared native Run input budget is unavailable');
          await expect(host.prepareInputBudget!()).resolves.toBe(budget);
          expect(contextPreparations).toBe(1);
          expect(requests.filter(request => ['thread/start', 'turn/start'].includes(request.method))).toEqual([]);
          const { runtimeId } = await host.provisionRuntime();
          const input = { text: `${'x'.repeat(budget - 1 + overflow)}🧭`, structuredInput: { v: 1, skillMentions: [
            { id: 'review', name: 'review', path: '/skills/review/SKILL.md', displayName: 'Review' },
          ] } };
          const delivery = host.deliverInput(runtimeId, input);
          if (overflow) await expect(delivery.then(() => null, readExecutionRunErrorCode)).resolves.toBe('provider_input_too_large');
          else await expect(delivery).resolves.toMatchObject({ status: 'admitted' });
          const turnStarts = requests.filter(request => request.method === 'turn/start');
          expect(turnStarts).toHaveLength(1);
          const submitted = turnStarts[0]?.params.input;
          expect(submitted).toContainEqual({ type: 'text', text: `${skillIndex}\n\n${input.text}` });
          expect(submitted).toContainEqual({ type: 'skill', name: 'review', path: '/skills/review/SKILL.md' });
          expect(contextPreparations).toBe(1);
        } finally { await host.dispose(); controller.abort(); }
      }, { maxInputUnicodeCharacters: limit });
    }
  });

  it.each([
    { title: 'generic application refusal', characters: 12, code: -32000, data: { privateBody: 'PRIVATE_PROVIDER_DETAIL' }, reason: 'provider_request_rejected', structuredInput: undefined },
    { title: 'provider size refusal above 1 MB', characters: 1_048_577, code: -32602,
      data: { input_error_code: 'input_too_large', max_chars: 1_048_576, actual_chars: 1_048_577, privateBody: 'PRIVATE_PROVIDER_DETAIL' },
      reason: 'provider_input_too_large', structuredInput: undefined },
    { title: 'provider size refusal with structured input', characters: 1_048_577, code: -32602,
      data: { input_error_code: 'input_too_large', max_chars: 1_048_576, actual_chars: 1_048_577, privateBody: 'PRIVATE_PROVIDER_DETAIL' },
      reason: 'provider_input_too_large', structuredInput: { v: 1, skillMentions: [
        { id: 'review', name: 'review', path: '/skills/review/SKILL.md', displayName: 'Review' },
      ] } },
  ])('settles $title without an accepted turn or orphan running Run', async ({ characters, code, data, reason, structuredInput }) => {
    await withCodexNativeAttachFixture(async ({ openConfiguredSession, requests, directory }) => {
      const session = await openConfiguredSession();
      const events: AgentSessionRuntimeEvent[] = [];
      const invariant = createAgentSessionTurnInvariant({ sessionId: 'actual-happier-session' });
      const violations: string[] = [];
      session.watch(event => {
        events.push(event);
        const observation = invariant.observe(event);
        if (observation.status === 'rejected') violations.push(observation.diagnostic.code);
      });
      const run = await createExecutionRunHostBackendFromSessionRuntime({
        request: { kind: 'resume', runId: 'refused-run', cwd: directory,
          profile: { pluginId: 'happier.agent.codex', localId: 'codex' }, checkpointId: 'fresh-thread' },
        sessionId: 'actual-happier-session', openSession: () => session,
      });
      const runEvents: AgentExecutionRunEvent[] = [];
      run.watch(event => runEvents.push(event));
      try {
        const result = await run.send({ text: 'x'.repeat(characters),
          ...(structuredInput ? { structuredInput } : {}),
        }, { localInputId: 'exact-refused-input' });
        expect(result).toMatchObject({ status: 'rejected', diagnostic: { code: reason,
          details: { providerErrorCode: code, method: 'turn/start', messageClass: 'JsonRpcApplicationError' } } });
        expect(events.filter(event => event.kind === 'input-rejected')).toEqual([
          expect.objectContaining({ inputIds: ['exact-refused-input'], retryable: false, diagnostic: result.diagnostic }),
        ]);
        expect(events.filter(event => ['input-accepted', 'input-custody-unknown', 'turn-start', 'turn-failed', 'runtime-ended'].includes(event.kind))).toEqual([]);
        expect(runEvents.filter(event => ['run-start', 'run-complete', 'run-failed'].includes(event.kind))).toEqual([
          expect.objectContaining({ kind: 'run-start' }),
          expect.objectContaining({ kind: 'run-failed', diagnostic: result.diagnostic }),
        ]);
        expect(invariant.read()).toMatchObject({ activeTurnId: null, knownTurnCount: 0, pendingAcceptedTurnCount: 0 });
        expect(violations).toEqual([]);
        expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
        const input = requests.find(request => request.method === 'turn/start')?.params.input;
        expect(Array.isArray(input) && input[0]?.text.length).toBe(characters);
        if (structuredInput) expect(input).toContainEqual({ type: 'skill', name: 'review', path: '/skills/review/SKILL.md' });
        expect(JSON.stringify([events, runEvents, result])).not.toContain('PRIVATE_PROVIDER_DETAIL');
        if (reason === 'provider_input_too_large') expect(result.diagnostic?.details).toMatchObject({ maxChars: 1_048_576, actualChars: characters });
      } finally { await run.dispose(); }
    }, { turnStartFailure: { code, message: 'PRIVATE_PROVIDER_DETAIL', data } });
  });

  it('keeps a disconnect without a response unknown and discards unaccepted lifecycle', async () => {
    await withCodexNativeAttachFixture(async ({ openConfiguredSession }) => {
      const session = await openConfiguredSession();
      const events: AgentSessionRuntimeEvent[] = [];
      const invariant = createAgentSessionTurnInvariant({ sessionId: 'actual-happier-session' });
      const violations: string[] = [];
      session.watch(event => {
        events.push(event);
        const observation = invariant.observe(event);
        if (observation.status === 'rejected') violations.push(observation.diagnostic.code);
      });
      const result = await session.send({ inputIds: ['lost-input'], input: { text: 'Reply OK.' },
        delivery: { kind: 'newTurn', turnId: 'lost-turn' } });
      expect(result).toMatchObject({ status: 'unavailable', diagnostic: { code: 'codex_send_outcome_unknown' } });
      expect(events.filter(event => event.kind === 'input-custody-unknown')).toHaveLength(1);
      expect(events.filter(event => ['input-accepted', 'input-rejected', 'turn-start', 'turn-failed'].includes(event.kind))).toEqual([]);
      expect(invariant.read()).toMatchObject({ activeTurnId: null, knownTurnCount: 0, pendingAcceptedTurnCount: 0 });
      expect(violations).toEqual([]);
    }, { disconnectBeforeTurnStartResponse: true });
  });

  it('preserves accepted turn output and completion while a steer request is refused', async () => {
    await withCodexNativeAttachFixture(async ({ openConfiguredSession }) => {
      const session = await openConfiguredSession();
      const events: AgentSessionRuntimeEvent[] = [];
      const invariant = createAgentSessionTurnInvariant({ sessionId: 'actual-happier-session' });
      const violations: string[] = [];
      session.watch(event => {
        events.push(event);
        const observation = invariant.observe(event);
        if (observation.status === 'rejected') violations.push(observation.diagnostic.code);
      });
      await expect(session.send({ inputIds: ['accepted-input'], input: { text: 'Start the turn.' },
        delivery: { kind: 'newTurn', turnId: 'accepted-turn' } })).resolves.toMatchObject({ status: 'admitted' });
      const result = await session.send({ inputIds: ['refused-steer'], input: { text: 'Steer this turn.' },
        delivery: { kind: 'steer', turnId: 'accepted-turn' } });
      expect(result).toMatchObject({ status: 'unavailable', diagnostic: { code: 'codex_send_outcome_unknown' } });
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        kind: 'turn-complete', turnId: 'accepted-turn',
      })));
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'message-delta', turnId: 'accepted-turn', text: 'Existing accepted turn output.',
      }));
      expect(events.filter(event => event.kind === 'input-accepted')).toEqual([
        expect.objectContaining({ inputIds: ['accepted-input'] }),
      ]);
      expect(events.filter(event => event.kind === 'turn-start')).toEqual([
        expect.objectContaining({ turnId: 'accepted-turn' }),
      ]);
      expect(invariant.read()).toMatchObject({ activeTurnId: null, pendingAcceptedTurnCount: 0 });
      expect(violations).toEqual([]);
    }, {
      turnSteerFailure: { code: -32000, message: 'Steer refused' },
      beforeTurnSteerResponse: async ({ socket }) => {
        socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: {
          threadId: 'fresh-thread', turnId: 'provider-turn-1', itemId: 'accepted-message', delta: 'Existing accepted turn output.',
        } }));
        socket.send(JSON.stringify({ method: 'turn/completed', params: {
          threadId: 'fresh-thread', turn: { id: 'provider-turn-1', status: 'completed' },
        } }));
      },
    });
  });

  it('does not publish an unaccepted turn failure after deferred quota evidence settles', async () => {
    let deferQuotaSnapshot = false;
    let releaseQuotaSnapshot!: () => void;
    const quotaSnapshotReleased = new Promise<void>(resolve => { releaseQuotaSnapshot = resolve; });
    let observeQuotaSnapshot!: () => void;
    const quotaSnapshotRequested = new Promise<void>(resolve => { observeQuotaSnapshot = resolve; });
    await withCodexNativeAttachFixture(async ({ runtime }) => {
      const session = createCodexNativeAppServerSessionRuntime(runtime, 'actual-happier-session');
      const events: AgentSessionRuntimeEvent[] = [];
      const invariant = createAgentSessionTurnInvariant({ sessionId: 'actual-happier-session' });
      const violations: string[] = [];
      session.watch(event => {
        events.push(event);
        const observation = invariant.observe(event);
        if (observation.status === 'rejected') violations.push(observation.diagnostic.code);
      });
      try {
        const sending = session.send({ inputIds: ['quota-refused-input'], input: { text: 'Reply OK.' },
          delivery: { kind: 'newTurn', turnId: 'quota-refused-turn' } });
        await quotaSnapshotRequested;
        await new Promise<void>(resolve => setImmediate(resolve));
        releaseQuotaSnapshot();
        const result = await sending;
        expect(result).toMatchObject({ status: 'rejected', retryable: false, diagnostic: {
          code: 'provider_request_rejected',
          details: { providerErrorCode: -32000, method: 'turn/start', messageClass: 'JsonRpcApplicationError' },
        } });
        await vi.waitFor(() => expect(runtime.isTurnInFlight()).toBe(false));
        expect(events.filter(event => event.kind === 'input-rejected')).toEqual([
          expect.objectContaining({ inputIds: ['quota-refused-input'], retryable: false, diagnostic: result.diagnostic }),
        ]);
        expect(events.filter(event => ['input-accepted', 'input-custody-unknown', 'turn-start', 'turn-failed'].includes(event.kind))).toEqual([]);
        expect(invariant.read()).toMatchObject({ activeTurnId: null, knownTurnCount: 0, pendingAcceptedTurnCount: 0 });
        expect(violations).toEqual([]);
      } finally {
        releaseQuotaSnapshot();
        await session.dispose();
      }
    }, {
      turnStartFailure: { code: -32000, message: 'Usage limit exceeded', data: { codexErrorInfo: 'UsageLimitExceeded' } },
      beforeTurnStartResponse: async () => { deferQuotaSnapshot = true; },
      rateLimitsRead: async () => {
        if (deferQuotaSnapshot) {
          observeQuotaSnapshot();
          await quotaSnapshotReleased;
        }
        return {};
      },
    });
  });
});
