import { hostBoundaries } from './nativeProcess.test-support.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentExecutionRunRuntimeContextV1,
  AgentSessionOpenRequest,
  AgentSessionModelsSource,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { buildPiAgentRuntimeDescriptorV1 } from '../../protocol/runtimeDescriptorV1.js';
import { createPiAgentRuntime } from './engine.js';
import { PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID } from '../auth/services/requestAuth/purposes.js';
import { PI_REQUEST_AUTH_CAPABILITY_PATH_ENV } from '../auth/services/requestAuth/index.js';

const openedSessions: AgentSessionRuntime[] = [];

describe('Pi Agent runtime', () => {
  afterEach(async () => {
    for (const session of openedSessions.splice(0)) await session.dispose();
    vi.useRealTimers();
  });

  it.each([undefined, null, 'default'])('refuses an unqualified ChatGPT default before native startup (%s)', async (model) => {
    const boundary = hostBoundaries();
    boundary.getBinding.mockImplementation(async (purpose) => purpose === PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID ? {
      purpose, service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'primary' },
      target: { kind: 'account', displayName: 'Primary' },
    } : null);
    await expect(createPiAgentRuntime().sessions.open({
      kind: 'create', sessionId: 'pi-codex-default', cwd: '/workspace',
      ...(model === undefined ? {} : { configuration: {
        mode: { value: null, updatedAtMs: 0 }, model: { value: model, updatedAtMs: 0 },
        permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {},
      } }),
    }, boundary.context)).rejects.toMatchObject({
      code: 'agent_startup_model_reconciliation_failed',
      details: { failureCause: { code: 'agent_startup_model_reconciliation_failed',
        phase: 'client_start', failureReason: 'model_selection_required', retryable: false } },
    });
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it.each(['create', 'resume'] as const)('applies a concrete ChatGPT choice through the real %s runtime', async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-selected-model-'));
    const boundary = hostBoundaries();
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    boundary.getBinding.mockImplementation(async (purpose) => purpose === PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID
      ? { purpose, service, account: { service, accountId: 'primary' }, target: { kind: 'account', displayName: 'Primary' } } : null);
    let session: AgentSessionRuntime | undefined;
    try {
      session = await createPiAgentRuntime().sessions.open({
        kind, ...(kind === 'resume' ? { providerSessionId: 'pi-shared' } : {}),
        sessionId: 'pi-selected-model', cwd: '/workspace',
        launchEnvironment: { values: { PI_CODING_AGENT_DIR: directory,
          [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: join(directory, 'capability.json') }, unset: [] },
        configuration: { mode: { value: null, updatedAtMs: 0 },
          model: { value: 'openai-codex/gpt-6-luna', updatedAtMs: 1, selectionSource: kind === 'create' ? 'explicit' : 'inherited' },
          permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {} },
      } as AgentSessionOpenRequest, boundary.context);
      expect(boundary.write).toHaveBeenCalledWith(expect.objectContaining({
        type: 'set_model', provider: 'openai-codex', modelId: 'gpt-6-luna',
      }));
    } finally { await session?.dispose(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('classifies a missing materialized Connected Account home without exposing launch values', async () => {
    const boundary = hostBoundaries();
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    boundary.getBinding.mockImplementation(async purpose => purpose === PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID
      ? { purpose, service, account: { service, accountId: 'primary' }, target: { kind: 'account', displayName: 'Primary' } } : null);
    const failure: unknown = await createPiAgentRuntime().sessions.open({
      kind: 'create', sessionId: 'pi-missing-home', cwd: '/workspace',
      launchEnvironment: { values: { OPENAI_API_KEY: 'private-launch-value' }, unset: [] },
      configuration: { mode: { value: null, updatedAtMs: 0 },
        model: { value: 'openai-codex/gpt-6-luna', updatedAtMs: 1, selectionSource: 'explicit' },
        permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {} },
    }, boundary.context).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'agent_startup_invalid_state', retryable: false,
      details: { failureCause: { code: 'agent_startup_invalid_state', phase: 'client_start',
        failureReason: 'unclassified_provider_error',
        providerErrorMessage: 'Pi qualified Connected Account launch requires the pre-materialized agent dir' } },
    });
    expect(JSON.stringify(failure)).not.toContain('private-launch-value');
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it('bounds preparation inside the aggregate session-open lifecycle and disposes a late result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let releaseBindings!: () => void;
    const bindings = new Promise<null>((resolve) => { releaseBindings = () => resolve(null); });
    let started!: () => void;
    const bindingStarted = new Promise<void>((resolve) => { started = resolve; });
    const boundary = hostBoundaries();
    boundary.getBinding.mockImplementation(async () => {
      started();
      return await bindings;
    });

    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    const opening = createPiAgentRuntime().sessions.open({
      kind: 'create',
      sessionId: 'pi-bounded-open',
      cwd: '/workspace',
    }, boundary.context).then(
      (runtime) => {
        outcome = 'resolved';
        return runtime;
      },
      (error: unknown) => {
        outcome = 'rejected';
        return error;
      },
    );

    await bindingStarted;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(outcome).toBe('rejected');
    await expect(opening).resolves.toMatchObject({
      message: expect.stringMatching(/timed out.*qualified Connected Account preparation/i),
    });

    expect(boundary.subscriptions.length).toBeGreaterThan(0);
    releaseBindings();
    await vi.advanceTimersByTimeAsync(0);
    for (const subscription of boundary.subscriptions) expect(subscription.dispose).toHaveBeenCalledOnce();
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it('cancels preparation from the host signal and disposes a late result', async () => {
    const controller = new AbortController();
    const boundary = hostBoundaries(controller.signal);
    let releaseBindings!: () => void;
    const bindings = new Promise<null>((resolve) => { releaseBindings = () => resolve(null); });
    let started!: () => void;
    const bindingStarted = new Promise<void>((resolve) => { started = resolve; });
    boundary.getBinding.mockImplementation(async () => {
      started();
      return await bindings;
    });
    const opening = createPiAgentRuntime().sessions.open({
      kind: 'create',
      sessionId: 'pi-cancelled-open',
      cwd: '/workspace',
    }, boundary.context);

    await bindingStarted;
    controller.abort(new Error('host cancelled Pi open'));
    await expect(opening).rejects.toThrow('host cancelled Pi open');

    expect(boundary.subscriptions.length).toBeGreaterThan(0);
    releaseBindings();
    await vi.waitFor(() => {
      for (const subscription of boundary.subscriptions) expect(subscription.dispose).toHaveBeenCalledOnce();
    });
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it('does not publish usage recovery without a provider-owned readiness fact', () => {
    const runtime = createPiAgentRuntime();
    expect(runtime.sessions.usageLimitRecovery).toBeUndefined();
  });

  it('interprets its bounded descriptor session file for an external resume', async () => {
    const sessionFile = '/home/lee/.pi/agent/sessions/workspace-a/pi-shared.jsonl';
    const boundary = hostBoundaries(undefined, {});

    const session = await createPiAgentRuntime().sessions.open({
      kind: 'resume',
      sessionId: 'happier-session-1',
      cwd: '/workspace',
      providerSessionId: 'pi-shared',
      runtimeDescriptorV1: buildPiAgentRuntimeDescriptorV1({
        resumeStrategy: 'sessionFileAbsolutePreferred',
        providerSessionId: 'pi-shared',
        sessionFile,
      }),
    } satisfies AgentSessionOpenRequest, boundary.context);
    openedSessions.push(session);

    const args = boundary.spawn.mock.calls[0]?.[0].launch.args;
    expect(args).toContain('--session');
    expect(args?.[args.indexOf('--session') + 1]).toBe(sessionFile);
    expect(boundary.write).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'new_session' }));
    const events: unknown[] = [];
    session.watch((event) => events.push(event));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'provider-session-id', providerSessionId: 'pi-shared' }));
  });

  it('applies the host-resolved configuration when opening a Session', async () => {
    const boundary = hostBoundaries();
    const boundModels: { source?: AgentSessionModelsSource } = {};
    const write = boundary.write.getMockImplementation()!;
    let releaseModel!: () => void;
    const modelAcknowledgment = new Promise<void>((resolve) => { releaseModel = resolve; });
    let requestedModel!: () => void;
    const modelRequested = new Promise<void>((resolve) => { requestedModel = resolve; });
    boundary.write.mockImplementation(async (record) => {
      if (record && typeof record === 'object' && !Array.isArray(record) && record.type === 'set_model') {
        requestedModel();
        await modelAcknowledgment;
      }
      await write(record);
    });
    const configuration = {
      mode: { value: null, updatedAtMs: 0 },
      model: { value: 'anthropic/claude-sonnet-4-6', updatedAtMs: 1 },
      permissionIntent: { value: 'read-only' as const, updatedAtMs: 1 },
      options: {},
    } as const;
    const request = {
      kind: 'create',
      sessionId: 'pi-configured-session',
      cwd: '/workspace',
      configuration,
    } satisfies AgentSessionOpenRequest;

    let opened = false;
    const opening = createPiAgentRuntime().sessions.open(request, {
      ...boundary.context,
      session: {
        ...boundary.context.session,
        services: {
          ...boundary.context.session.services,
          models: {
            bind(source) {
              boundModels.source = source;
              return { dispose() {} };
            },
          },
        },
      },
    }).then((session) => {
      opened = true;
      openedSessions.push(session);
      return session;
    });
    await modelRequested;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(opened).toBe(false);
    expect(boundary.write).toHaveBeenCalledWith(expect.objectContaining({
      type: 'set_model', provider: 'anthropic', modelId: 'claude-sonnet-4-6',
    }));
    const args = boundary.spawn.mock.calls[0]?.[0].launch.args;
    expect(args?.[args.indexOf('--tools') + 1]).toBe('read,grep,find,ls');
    releaseModel();
    await opening;
    expect(opened).toBe(true);
    await boundary.emit({
      type: 'happier-pi-model-catalog',
      models: [{ provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true }],
    });
    expect(boundModels.source?.read()).toMatchObject({
      models: [{ id: 'anthropic/claude-sonnet-4-6' }],
    });
  });

  it('keeps an admitted finite run alive across Connected Account resync until explicit disposal', async () => {
    const boundary = hostBoundaries();
    const open = createPiAgentRuntime().sessions.executionRunContextV1!.open;
    const run = await open({
      kind: 'create', runId: 'pi-account-continuity', cwd: '/workspace',
      profile: { pluginId: 'happier.agent.pi', localId: 'default' },
      input: { text: 'Keep working.' },
    }, boundary.context as unknown as AgentExecutionRunRuntimeContextV1);
    try {
      await vi.waitFor(() => expect(boundary.spawn).toHaveBeenCalled());
      // Let the real finite host finish opening its native conversation.
      await vi.waitFor(() => expect(boundary.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt' })));
      for (const subscription of boundary.subscriptions) await subscription.listener();
      expect(boundary.disposeProcess).not.toHaveBeenCalled();
    } finally {
      await run.dispose();
    }
    // The finite host settles disposal before its detached provider cleanup.
    await vi.waitFor(() => expect(boundary.disposeProcess).toHaveBeenCalled());
  });

  it('binds Connected Account invalidation outside Pi tool-extension cleanup', async () => {
    const boundary = hostBoundaries();

    const session = await createPiAgentRuntime().sessions.open({
      kind: 'create',
      sessionId: 'pi-invalidation-cleanup',
      cwd: '/workspace',
    }, {
      ...boundary.context,
      session: {
        id: 'pi-invalidation-cleanup',
        services: {
          happierTools: {
            resolveNativeBridge: vi.fn(async () => ({
              v: 1, directory: '/workspace', systemPrompt: '',
              tools: [],
            })),
          },
        },
      },
    } as unknown as AgentSessionRuntimeContext);
    openedSessions.push(session);
    const args = boundary.spawn.mock.calls[0]?.[0].launch.args;
    const configPath = args?.[args.indexOf('--happier-tools-config') + 1];
    if (!configPath) throw new Error('Expected a materialized Pi tools config');
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ v: 1, directory: '/workspace', tools: [] });
    expect(boundary.subscriptions.length).toBeGreaterThan(0);
    await boundary.subscriptions[0]!.listener({ kind: 'resync', authorityChanged: false });
    expect(boundary.disposeProcess).not.toHaveBeenCalled();
    expect(existsSync(configPath)).toBe(true);
    await boundary.subscriptions[0]!.listener({ kind: 'resync', authorityChanged: true });
    expect(boundary.disposeProcess).toHaveBeenCalled();
    expect(existsSync(configPath)).toBe(false);
    for (const subscription of boundary.subscriptions) expect(subscription.dispose).toHaveBeenCalledOnce();
  });
});
