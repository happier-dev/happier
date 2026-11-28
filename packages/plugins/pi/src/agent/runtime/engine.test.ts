import { hostBoundaries } from './nativeProcess.test-support.js';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSensitiveDiagnosticValues } from '@happier-dev/protocol/bugs/reports/redaction';

import type {
  AgentExecutionRunRuntimeContextV1,
  AgentSessionOpenRequest,
  AgentSessionModelsSource,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { sanitizeNativeAgentSessionBoundaryError } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';

import { buildPiAgentRuntimeDescriptorV1 } from '../../protocol/runtimeDescriptorV1.js';
import { createPiAgentRuntime } from './engine.js';
import { PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID } from '../auth/services/requestAuth/purposes.js';
import { PI_REQUEST_AUTH_CAPABILITY_PATH_ENV } from '../auth/services/requestAuth/index.js';
import { PI_PROVIDER_SECRET_ENV_KEY } from '../launchEnvironment.js';
import {
  buildPiResumeSearchRoots,
  encodePiSessionDirectoryCwd,
  findPiSessionFileForId,
  formatPiSessionDirectoryForCwd,
} from '../sessionFiles.js';

const openedSessions: AgentSessionRuntime[] = [];

describe('Pi Agent runtime', () => {
  afterEach(async () => {
    for (const session of openedSessions.splice(0)) await session.dispose();
    vi.useRealTimers();
  });

  it.skipIf(process.platform !== 'linux').each(['oversized', 'configured', 'ordinary'] as const)(
    'opens a persistent Session with %s Pi storage',
    async (storage) => {
      const root = mkdtempSync(join(tmpdir(), 'pi-deep-checkout-'));
      try {
        const cwd = storage === 'ordinary' ? join(root, 'project')
          : join(root, 'managed-project-'.repeat(9), 'nested-checkout-'.repeat(9));
        const agentDir = join(root, 'native-home');
        const sessionsRoot = join(agentDir, 'sessions');
        const configuredSessionDir = storage === 'configured' ? join(root, 'configured-sessions') : undefined;
        mkdirSync(cwd, { recursive: true });
        if (configuredSessionDir) {
          mkdirSync(join(cwd, '.pi'));
          writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ sessionDir: configuredSessionDir }));
        }
        const nativeSessionId = '019e461b-24e2-73a9-acf4-19bc50210729';
        const fileName = `2026-05-20T15-57-24-578Z_${nativeSessionId}.jsonl`;
        const transcript = JSON.stringify({ type: 'session', version: 3, id: nativeSessionId, cwd }) + '\n';
        const boundary = hostBoundaries(undefined, { sessionId: nativeSessionId });
        const spawn = boundary.spawn.getMockImplementation()!;
        boundary.spawn.mockImplementation(async (spec) => {
          // Match Pi 1.6.0's mkdir at the process boundary, using the real filesystem.
          const flag = spec.launch.args.indexOf('--session-dir');
          const sessionDir = flag === -1
            ? configuredSessionDir ?? join(sessionsRoot, `--${encodePiSessionDirectoryCwd(cwd)}--`)
            : spec.launch.args[flag + 1]!;
          mkdirSync(sessionDir, { recursive: true });
          writeFileSync(join(sessionDir, fileName), transcript);
          return spawn(spec);
        });
        const session = await createPiAgentRuntime().sessions.open({
          kind: 'create', sessionId: 'deep-checkout-session', cwd,
          launchEnvironment: { values: { PI_CODING_AGENT_DIR: agentDir }, unset: [] },
        }, boundary.context);
        try {
          if (configuredSessionDir) {
            expect(existsSync(configuredSessionDir)).toBe(true);
            expect(existsSync(sessionsRoot)).toBe(false);
          } else if (storage === 'ordinary') {
            expect(existsSync(join(sessionsRoot, formatPiSessionDirectoryForCwd(cwd)))).toBe(true);
          } else {
            const roots = buildPiResumeSearchRoots({
              cwd,
              env: { PI_CODING_AGENT_DIR: agentDir },
              targetStrict: true,
            });
            const found = await findPiSessionFileForId({ sessionId: nativeSessionId, roots });
            expect(found).not.toBeNull();
            expect(readFileSync(found!, 'utf8')).toBe(transcript);
            expect(readdirSync(sessionsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())).toHaveLength(1);
          }
        } finally {
          await session.dispose();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['get_state', 'set_model'])('preserves the process exit diagnostic when Pi exits during startup %s', async command => {
    const boundary = hostBoundaries();
    const launchKey = 'fake-opaque-provider-key';
    const providerKeyPresent = command === 'get_state';
    const redaction = registerSensitiveDiagnosticValues([launchKey]);
    const stderr = new TextEncoder().encode(
      `Pi extension startup detail
${'diagnostic context '.repeat(200)}
Fatal startup marker: ${launchKey}
`,
    );
    const write = boundary.write.getMockImplementation()!;
    boundary.write.mockImplementation(async record => {
      if (record === null || typeof record !== 'object' || Array.isArray(record) || record.type !== command) {
        await write(record);
        return;
      }
      boundary.finish({
        termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } },
        stdout: new Uint8Array(), stderr, stdoutTruncated: false, stderrTruncated: false,
      });
    });
    const error = await createPiAgentRuntime().sessions.open({
      kind: 'create', sessionId: 'pi-startup-exit', cwd: '/workspace',
      launchEnvironment: { values: providerKeyPresent ? { [PI_PROVIDER_SECRET_ENV_KEY]: launchKey } : {}, unset: [] },
      configuration: {
        mode: { value: null, updatedAtMs: 0 },
        model: { value: 'github-copilot/fixture-model', updatedAtMs: 0 },
        permissionIntent: { value: null, updatedAtMs: 0 },
        options: {},
      },
    }, boundary.context).catch((error: unknown) => error).finally(() => redaction.close());
    const issue = classifyPrimarySessionRuntimeIssue({
      cause: 'session_error', startupPhase: 'client_start',
      error: sanitizeNativeAgentSessionBoundaryError(error, true),
    });
    expect(issue.failureCause).toMatchObject({
      phase: 'client_start', providerErrorCode: 'pi_rpc_unexpected_exit',
    });
    const log = vi.mocked(boundary.context.services.logger.diagnostic);
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      code: 'pi_rpc_unexpected_exit',
      details: expect.objectContaining({
        executableBasename: 'pi',
        resolutionClass: 'system',
        executableVersion: '0.82.1',
        environmentVariable: PI_PROVIDER_SECRET_ENV_KEY,
        environmentVariablePresent: providerKeyPresent,
        stderrTail: expect.stringContaining('Pi extension startup detail'),
      }),
    }));
    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).toContain('Fatal startup marker: [REDACTED]');
    expect(serialized).not.toContain(launchKey);
    expect(JSON.stringify(issue)).not.toContain('Pi extension startup detail');
  });

  it.each([false, true])('retains a typed native configuration failure through Session opening (cleanup fails=%s)', async cleanupFails => {
    const boundary = hostBoundaries();
    const write = boundary.write.getMockImplementation()!;
    if (cleanupFails) boundary.disposeProcess.mockRejectedValueOnce(new Error('Native cleanup failed'));
    const failureCause = { code: 'provider_endpoint_unavailable', phase: 'client_start', failureReason: 'permission_denied', httpStatus: 503 } as const;
    boundary.write.mockImplementation(async record => {
      if (record && typeof record === 'object' && !Array.isArray(record) && record.type === 'set_model') {
        throw Object.assign(new Error('Native model configuration refused'), { failureCause });
      }
      await write(record);
    });
    await expect(createPiAgentRuntime().sessions.open({
      kind: 'create', sessionId: 'pi-config-cause', cwd: '/workspace',
      configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: 'github-copilot/fixture-model', updatedAtMs: 0 },
        permissionIntent: { value: null, updatedAtMs: 0 }, options: {} },
    }, boundary.context)).rejects.toMatchObject(cleanupFails ? { failureCause } : { details: { failureCause } });
    expect(boundary.disposeProcess).toHaveBeenCalled();
  });

  it('returns a model prerequisite with the native refusal through Session opening', async () => {
    const boundary = hostBoundaries();
    const write = boundary.write.getMockImplementation()!;
    boundary.write.mockImplementation(async record => {
      if (record && typeof record === 'object' && !Array.isArray(record)
        && record.type === 'set_model' && typeof record.id === 'string') {
        await boundary.emit({ type: 'response', id: record.id, command: 'set_model', success: false,
          error: 'Model not found: github-copilot/fixture-model; Authorization: Bearer private-fixture-token' });
      } else await write(record);
    });
    const failure: unknown = await createPiAgentRuntime().sessions.open({
      kind: 'create', sessionId: 'pi-config-refusal', cwd: '/workspace',
      configuration: {
        mode: { value: null, updatedAtMs: 0 },
        model: { value: 'github-copilot/fixture-model', updatedAtMs: 0 },
        permissionIntent: { value: null, updatedAtMs: 0 }, options: {},
      },
    }, boundary.context).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
      details: { failureCause: { code: 'agent_startup_model_reconciliation_failed', phase: 'client_start',
        failureReason: 'model_selection_required',
        providerErrorCode: 'pi_configuration_failed',
        providerErrorMessage: expect.stringContaining('Model not found: github-copilot/fixture-model') } } });
    expect(JSON.stringify(failure)).not.toContain('private-fixture-token');
    expect(boundary.disposeProcess).toHaveBeenCalled();
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

  it('finishes admitted startup when account observations change during native open', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-admitted-startup-'));
    const boundary = hostBoundaries();
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    boundary.getBinding.mockImplementation(async purpose => purpose === PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID
      ? { purpose, service, account: { service, accountId: 'primary' }, target: { kind: 'account', displayName: 'Primary' } } : null);
    const write = boundary.write.getMockImplementation()!;
    boundary.write.mockImplementation(async record => {
      if (record && typeof record === 'object' && !Array.isArray(record) && record.type === 'get_state') {
        for (const subscription of boundary.subscriptions) await subscription.listener();
      }
      await write(record);
    });
    let session: AgentSessionRuntime | undefined;
    try {
      session = await createPiAgentRuntime().sessions.open({
        kind: 'create', sessionId: 'pi-admitted-startup', cwd: '/workspace',
        launchEnvironment: { values: { PI_CODING_AGENT_DIR: directory,
          [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: join(directory, 'capability.json') }, unset: [] },
        configuration: { mode: { value: null, updatedAtMs: 0 },
          model: { value: 'openai-codex/gpt-5.5', updatedAtMs: 1, selectionSource: 'explicit' },
          permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {} },
      }, boundary.context);
      expect(boundary.disposeProcess).not.toHaveBeenCalled();
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
      permissionIntent: { value: 'yolo' as const, updatedAtMs: 1 },
      workspaceWrites: 'deny',
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
    expect(args).not.toContain('--tools');
    const toolsConfigPath = args?.[args.indexOf('--happier-tools-config') + 1];
    expect(toolsConfigPath).toBeTruthy();
    expect(JSON.parse(readFileSync(toolsConfigPath!, 'utf8'))).toMatchObject({
      nativeTools: ['read', 'grep', 'find', 'ls'],
    });
    releaseModel();
    const session = await opening;
    expect(opened).toBe(true);
    await expect(session.updateConfiguration!({ ...configuration, workspaceWrites: 'allow' }))
      .resolves.toMatchObject({
        status: 'unsupported', diagnostic: { code: 'pi_permission_change_requires_restart' },
      });
    await boundary.emit({
      type: 'happier-pi-model-catalog',
      models: [{ provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true }],
    });
    expect(boundModels.source?.read()).toMatchObject({
      models: [{ id: 'anthropic/claude-sonnet-4-6' }],
    });
  });

  it.each(['deny', 'allow'] as const)('launches a Pi judge run with workspace writes set to %s', async (workspaceWrites) => {
    const boundary = hostBoundaries();
    const runId = 'pi-judge-policy';
    const run = await createPiAgentRuntime().sessions.executionRunContextV1!.open({
      kind: 'create', runId, cwd: '/workspace',
      profile: { pluginId: 'happier.agent.pi', localId: 'default' },
      input: { text: 'Judge whether the work is complete.' },
      configuration: {
        mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: 'yolo', updatedAtMs: 1 }, options: {}, workspaceWrites,
      },
    }, { ...boundary.context, executionRun: { id: runId, services: {} } } as unknown as AgentExecutionRunRuntimeContextV1);
    try {
      await vi.waitFor(() => expect(boundary.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt' })));
      const args = boundary.spawn.mock.calls[0]![0].launch.args;
      const configPath = args[args.indexOf('--happier-tools-config') + 1]!;
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
        nativeTools: workspaceWrites === 'deny' ? ['read', 'grep', 'find', 'ls'] : null,
      });
    } finally {
      await run.dispose();
    }
  });

  it('refuses an exclusive empty tool allowlist before starting a Pi run', async () => {
    const boundary = hostBoundaries();
    const open = createPiAgentRuntime().sessions.executionRunContextV1!.open;
    const outcome = open({
      kind: 'create', runId: 'pi-no-tools', cwd: '/workspace',
      profile: { pluginId: 'happier.agent.pi', localId: 'default' },
      input: { text: 'Summarize the source.' },
      configuration: {
        mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: 'read-only', updatedAtMs: 1 }, options: {},
        allowedTools: [], unlistedTools: 'deny',
      },
    }, { ...boundary.context, executionRun: { id: 'pi-no-tools', services: {} } } as unknown as AgentExecutionRunRuntimeContextV1)
      .then(async (run) => {
        try {
          await vi.waitFor(() => expect(boundary.spawn).toHaveBeenCalled());
          return boundary.spawn.mock.calls[0]?.[0].launch.args;
        } finally {
          await run.dispose();
        }
      });

    await expect(outcome).rejects.toMatchObject({
      code: 'unsupported',
      retryable: false,
      message: expect.stringContaining('cannot enforce'),
    });
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it('keeps an admitted finite run alive across Connected Account resync until explicit disposal', async () => {
    const boundary = hostBoundaries();
    const open = createPiAgentRuntime().sessions.executionRunContextV1!.open;
    const run = await open({
      kind: 'create', runId: 'pi-account-continuity', cwd: '/workspace',
      profile: { pluginId: 'happier.agent.pi', localId: 'default' },
      input: { text: 'Keep working.' },
    }, { ...boundary.context, executionRun: { id: 'pi-account-continuity', services: {} } } as unknown as AgentExecutionRunRuntimeContextV1);
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

  it('keeps an admitted Session alive when its account invalidates during native spawn', async () => {
    const boundary = hostBoundaries();
    const spawn = boundary.spawn.getMockImplementation()!;
    boundary.spawn.mockImplementation(async (spec) => {
      const handle = await spawn(spec);
      await boundary.subscriptions[0]!.listener();
      return handle;
    });
    const session = await createPiAgentRuntime().sessions.open({
      kind: 'create', sessionId: 'pi-invalidated-during-open', cwd: '/workspace',
    }, boundary.context);
    openedSessions.push(session);
    expect(boundary.disposeProcess).not.toHaveBeenCalled();
    await session.dispose();
    expect(boundary.disposeProcess).toHaveBeenCalledOnce();
    for (const subscription of boundary.subscriptions) expect(subscription.dispose).toHaveBeenCalledOnce();
  });

  it.each(['create', 'resume'] as const)('keeps the admitted %s Session and tool assets usable after account resync', async (kind) => {
    const boundary = hostBoundaries();

    const session = await createPiAgentRuntime().sessions.open({
      kind,
      ...(kind === 'resume' ? { providerSessionId: 'pi-shared' } : {}),
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
    for (const subscription of boundary.subscriptions) expect(subscription.dispose).not.toHaveBeenCalled();
    await expect(session.send({ inputIds: ['first'], input: { text: 'First turn.' },
      delivery: { kind: 'newTurn', turnId: 'first' } })).resolves.toMatchObject({ status: 'admitted' });
    await boundary.emit({ type: 'agent_end', willRetry: false });
    await boundary.subscriptions[0]!.listener({ kind: 'resync', authorityChanged: false });
    expect(boundary.disposeProcess).not.toHaveBeenCalled();
    expect(existsSync(configPath)).toBe(true);
    await boundary.subscriptions[0]!.listener({ kind: 'resync', authorityChanged: true });
    await expect(session.send({ inputIds: ['next'], input: { text: 'Next turn.' },
      delivery: { kind: 'newTurn', turnId: 'next' } })).resolves.toMatchObject({ status: 'admitted' });
    expect(boundary.disposeProcess).not.toHaveBeenCalled();
    expect(existsSync(configPath)).toBe(true);
    await session.dispose();
    expect(boundary.disposeProcess).toHaveBeenCalled();
    expect(existsSync(configPath)).toBe(false);
    for (const subscription of boundary.subscriptions) expect(subscription.dispose).toHaveBeenCalledOnce();
  });
});
