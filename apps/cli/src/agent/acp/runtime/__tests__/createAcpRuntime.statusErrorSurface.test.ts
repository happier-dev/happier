import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';

import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { AcpPromptSubmissionPhaseError } from '@/agent/acp/AcpBackend';
import { ProviderPromptSubmissionRejectedBeforeEffectError } from '@/agent/runtime/providerPromptSubmission';
import { PiRpcBackend } from '@/backends/pi/rpc/PiRpcBackend';

describe('createAcpRuntime (status error surfacing)', () => {
  afterEach(() => {
    delete process.env.HAPPIER_ACP_FAILURE_TRACE;
    vi.restoreAllMocks();
  });

  it('surfaces non-abort status:error as sanitized primary-session failure', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const sent: ACPMessageData[] = [];
    const failedTurns: unknown[] = [];
    const session = {
      ...createBasicSessionClientWithOverrides({
        sendAgentMessage: (_provider, body) => {
          sent.push(body);
        },
      }),
      sessionTurnLifecycle: {
        beginTurn: async () => ({ turnId: 'session-turn-1' }),
        attachProviderTurnId: async () => {},
        appendTranscriptAnchors: async () => {},
        completeTurn: async () => {},
        failTurn: async (record: unknown) => {
          failedTurns.push(record);
        },
        cancelTurn: async () => {},
        endSession: async () => {},
        markRollbackEligible: async () => {},
        markRolledBack: async () => {},
        touchActiveTurn: async () => {},
        hasActiveTurn: () => false,
      },
    };

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'status', status: 'error', detail: 'Model not found.' } satisfies AgentMessage);
    await Promise.resolve();
    await Promise.resolve();

    expect(sent.some((msg) => msg.type === 'message' && msg.message.includes('Model not found'))).toBe(false);
    await expect.poll(() => sent.some((msg) => msg.type === 'turn_failed')).toBe(true);
    const turnFailed = sent.find((msg) => msg.type === 'turn_failed');
    expect(turnFailed).toEqual(expect.objectContaining({
      type: 'turn_failed',
      issue: expect.objectContaining({
        source: 'provider_status_error',
        sanitizedPreview: 'Provider reported an error',
      }),
    }));
    expect(sent.some((msg) => msg.type === 'turn_aborted')).toBe(false);
    expect(failedTurns).toEqual([
      expect.objectContaining({
        provider: 'pi',
        issue: expect.objectContaining({
          source: 'provider_status_error',
          sanitizedPreview: 'Provider reported an error',
        }),
      }),
    ]);
    expect(JSON.stringify(failedTurns)).not.toContain('Model not found');
  });

  it('flushes pending permission requests on status:error', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const flushReasons: string[] = [];

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: createBasicSessionClientWithOverrides(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: {
        ...createApprovedPermissionHandler(),
        abortPendingRequestsAndFlush: async (reason: string) => {
          flushReasons.push(reason);
        },
      },
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'status', status: 'error', detail: 'Model not found.' } satisfies AgentMessage);
    await Promise.resolve();
    await Promise.resolve();

    expect(flushReasons).toEqual(['ACP runtime status:error']);
  });

  it('writes opt-in sanitized Pi ACP prompt-failure traces without raw error text', async () => {
    process.env.HAPPIER_ACP_FAILURE_TRACE = '1';
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: createBasicSessionClientWithOverrides(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    await runtime.failTurn(new Error(
      'Provider session failed while handling sensitive prompt marker sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ));

    const tracePayloads = debugSpy.mock.calls
      .filter(([message]) => message === '[acp] prompt failure trace')
      .map(([, payload]) => payload);
    expect(tracePayloads).toEqual([
      expect.objectContaining({
        provider: 'pi',
        branch: 'surface_prompt_failure',
        cause: 'session_error',
        errorMessageKind: 'other',
        issueSource: 'provider_session_error',
        issueCode: 'provider_session_error',
        compatibilityMarkerSent: false,
      }),
    ]);

    const serialized = JSON.stringify(tracePayloads);
    expect(serialized).not.toContain('sensitive prompt marker');
    expect(serialized).not.toContain('sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(serialized).not.toContain('Provider session failed while handling');
  });

  it('normalizes exact generic Pi prompt failures after prompt acceptance to a Pi diagnostic', async () => {
    process.env.HAPPIER_ACP_FAILURE_TRACE = '1';
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const sent: ACPMessageData[] = [];
    const mutations: SessionTurnMutationV1[] = [];
    const sessionTurnLifecycle = createSessionTurnLifecycle({
      sessionId: 'happy-session-1',
      createId: () => 'pi-acp-turn-1',
      now: () => 123,
      enqueueSessionTurn: async (mutation) => {
        mutations.push(mutation);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: {
        ...createBasicSessionClientWithOverrides({
          sendAgentMessage: (_provider, body) => {
            sent.push(body);
          },
        }),
        sessionTurnLifecycle,
      },
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    await runtime.failTurn(new Error('Provider session failed'));

    expect(sent).toContainEqual(expect.objectContaining({
      type: 'turn_failed',
      issue: expect.objectContaining({
        provider: 'pi',
        source: 'provider_session_error',
        code: 'provider_session_error',
        sanitizedPreview: 'Pi provider reported provider session failure after prompt acceptance',
      }),
    }));
    expect(mutations).toEqual([
      expect.objectContaining({
        action: 'begin',
        provider: 'pi',
      }),
      expect.objectContaining({
        action: 'fail',
        provider: 'pi',
        issue: expect.objectContaining({
          sanitizedPreview: 'Pi provider reported provider session failure after prompt acceptance',
        }),
      }),
    ]);
    const tracePayloads = debugSpy.mock.calls
      .filter(([message]) => message === '[acp] prompt failure trace')
      .map(([, payload]) => payload);
    expect(tracePayloads).toEqual([
      expect.objectContaining({
        provider: 'pi',
        branch: 'surface_prompt_failure',
        errorMessageKind: 'generic_provider_session_failed',
        issuePreviewKind: 'pi_provider_diagnostic',
        compatibilityMarkerSent: true,
      }),
    ]);
  });

  it('preserves a Pi broker readiness failure before provider send through the ACP failure surface', async () => {
    const backend = new PiRpcBackend({
      cwd: '/tmp',
      command: process.execPath,
      args: [],
      env: {},
    });
    const providerCommands: string[] = [];
    const brokerHarness = backend as unknown as {
      connectedBrokerPreflight: Promise<
        | Readonly<{ ready: true }>
        | Readonly<{ ready: false; reason: string }>
      > | null;
      ensureProcess: () => Promise<void>;
      sendCommand: (command: Readonly<{ type: string }>) => Promise<unknown>;
    };
    brokerHarness.ensureProcess = async () => {};
    brokerHarness.sendCommand = async (command) => {
      providerCommands.push(command.type);
      if (command.type === 'get_state') {
        return {
          type: 'response',
          command: command.type,
          success: true,
          data: { sessionId: 'pi-broker-readiness-session' },
        };
      }
      return {
        type: 'response',
        command: command.type,
        success: true,
        data: command.type === 'get_available_models' ? { models: [] } : { commands: [] },
      };
    };
    brokerHarness.connectedBrokerPreflight = Promise.resolve({ ready: true });

    const sent: ACPMessageData[] = [];
    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: createBasicSessionClientWithOverrides({
        sendAgentMessage: (_provider, body) => sent.push(body),
      }),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    providerCommands.length = 0;
    brokerHarness.connectedBrokerPreflight = Promise.resolve({
      ready: false,
      reason: 'broker_extension_not_loaded',
    });
    runtime.beginTurn();

    const promptError = await runtime.sendPromptWithMeta({ text: 'hello' }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(promptError).not.toBeNull();
    await runtime.failTurn(promptError);

    expect(providerCommands).toEqual([]);
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'turn_failed',
      issue: expect.objectContaining({
        provider: 'pi',
        source: 'dependency_failure',
        code: 'pi_broker_readiness_failure',
        sanitizedPreview: 'Pi connected-service broker was not ready before provider send',
      }),
    }));
    expect(JSON.stringify(sent)).not.toContain('after prompt acceptance');
    expect(JSON.stringify(sent)).not.toContain('broker_extension_not_loaded');
  });

  it('preserves a Pi provider failure through the live ACP submission wrapper chain', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const sent: ACPMessageData[] = [];
    const providerFailure = Object.assign(new Error(
      'Pi provider reported provider failure after prompt acceptance: code=provider_auth_failed, message=Credential [REDACTED] was rejected',
    ), {
      piProviderFailure: {
        classification: 'pi_provider_failure',
        code: 'provider_auth_failed',
        sanitizedPreview:
          'Pi provider reported provider failure after prompt acceptance: code=provider_auth_failed, message=Credential [REDACTED] was rejected',
      },
    });
    const wrapped = new ProviderPromptSubmissionRejectedBeforeEffectError(
      'provider_rejected_before_acceptance',
      new AcpPromptSubmissionPhaseError('rejected_before_effect', providerFailure),
    );
    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: createBasicSessionClientWithOverrides({
        sendAgentMessage: (_provider, body) => sent.push(body),
      }),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();
    await runtime.failTurn(wrapped);

    expect(sent).toContainEqual(expect.objectContaining({
      type: 'turn_failed',
      issue: expect.objectContaining({
        source: 'provider_session_error',
        code: 'provider_auth_failed',
        sanitizedPreview:
          'Pi provider reported provider failure after prompt acceptance: code=provider_auth_failed, message=Credential [REDACTED] was rejected',
      }),
    }));
  });

  it('normalizes generic surfaced Pi prompt failures with wrapper raw errors after prompt acceptance', async () => {
    process.env.HAPPIER_ACP_FAILURE_TRACE = '1';
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const sent: ACPMessageData[] = [];
    const mutations: SessionTurnMutationV1[] = [];
    const sessionTurnLifecycle = createSessionTurnLifecycle({
      sessionId: 'happy-session-1',
      createId: () => 'pi-acp-turn-wrapper',
      now: () => 123,
      enqueueSessionTurn: async (mutation) => {
        mutations.push(mutation);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: {
        ...createBasicSessionClientWithOverrides({
          sendAgentMessage: (_provider, body) => {
            sent.push(body);
          },
        }),
        sessionTurnLifecycle,
      },
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    await runtime.failTurn(new Error(
      'some wrapper text around Provider session failed that is not exact sk-proj-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ));

    expect(sent).toContainEqual(expect.objectContaining({
      type: 'turn_failed',
      issue: expect.objectContaining({
        provider: 'pi',
        source: 'provider_session_error',
        code: 'provider_session_error',
        sanitizedPreview: 'Pi provider reported provider session failure after prompt acceptance',
      }),
    }));
    expect(mutations).toEqual([
      expect.objectContaining({
        action: 'begin',
        provider: 'pi',
      }),
      expect.objectContaining({
        action: 'fail',
        provider: 'pi',
        issue: expect.objectContaining({
          sanitizedPreview: 'Pi provider reported provider session failure after prompt acceptance',
        }),
      }),
    ]);

    const tracePayloads = debugSpy.mock.calls
      .filter(([message]) => message === '[acp] prompt failure trace')
      .map(([, payload]) => payload);
    expect(tracePayloads).toEqual([
      expect.objectContaining({
        provider: 'pi',
        branch: 'surface_prompt_failure',
        errorMessageKind: 'other',
        issuePreviewKind: 'pi_provider_diagnostic',
        compatibilityMarkerSent: true,
      }),
    ]);

    const serializedSurface = JSON.stringify({ sent, mutations, tracePayloads });
    expect(serializedSurface).not.toContain('some wrapper text around');
    expect(serializedSurface).not.toContain('sk-proj-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('preserves Pi terminal failure diagnostics on the turn_failed issue marker', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const sent: ACPMessageData[] = [];

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: createBasicSessionClientWithOverrides({
        sendAgentMessage: (_provider, body) => {
          sent.push(body);
        },
      }),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({
      type: 'status',
      status: 'error',
      detail: 'Pi provider reported assistant_message_end failed without details after prompt acceptance',
    } satisfies AgentMessage);

    await expect.poll(() => sent.find((msg) => msg.type === 'turn_failed')).toEqual(expect.objectContaining({
      type: 'turn_failed',
      issue: expect.objectContaining({
        provider: 'pi',
        source: 'provider_status_error',
        sanitizedPreview: 'Pi provider reported assistant_message_end failed without details after prompt acceptance',
      }),
    }));
  });

  it('does not surface abort-like status:error detail as a transcript message', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const sent: ACPMessageData[] = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({
      type: 'status',
      status: 'error',
      detail: 'Error: OpenCode session aborted\n    at Object.cancel (/tmp/runtime.ts:10:1)',
    } satisfies AgentMessage);
    await Promise.resolve();
    await Promise.resolve();

    expect(sent.some((msg) => msg.type === 'message' && msg.message.includes('OpenCode session aborted'))).toBe(false);
    expect(sent.some((msg) => msg.type === 'message' && msg.message.includes('at Object.cancel'))).toBe(false);
    expect(sent.some((msg) => msg.type === 'turn_aborted')).toBe(true);
  });

  it('opens and fails a lifecycle turn when status:error arrives before task_started', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const mutations: SessionTurnMutationV1[] = [];
    const sessionTurnLifecycle = createSessionTurnLifecycle({
      sessionId: 'happy-session-1',
      createId: () => 'turn-1',
      now: () => 123,
      enqueueSessionTurn: async (mutation) => {
        mutations.push(mutation);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: {
        ...createBasicSessionClientWithOverrides(),
        sessionTurnLifecycle,
      },
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'status', status: 'error', detail: 'Model not found.' } satisfies AgentMessage);
    await Promise.resolve();
    await Promise.resolve();

    await expect.poll(() => mutations).toEqual([
      expect.objectContaining({
        action: 'begin',
        turnId: 'session-turn:turn-1',
        provider: 'pi',
      }),
      expect.objectContaining({
        action: 'fail',
        turnId: 'session-turn:turn-1',
        provider: 'pi',
        issue: expect.objectContaining({
          source: 'provider_status_error',
        }),
      }),
    ]);
  });
});
