import { describe, expect, it, vi } from 'vitest';

import { createElevenLabsProtocolAdapter } from './elevenLabsProtocolAdapter.js';
import { createElevenLabsEventMapper } from './elevenLabsEventMapper.js';

describe('createElevenLabsProtocolAdapter', () => {
  it('maps controller preparation into provider-owned session config and lifecycle metadata', async () => {
    const prepareSessionStart = vi.fn(async () => ({
      kind: 'prepared' as const,
      session: {
        sessionConfig: {
          sessionId: 'control-1',
          token: 'ephemeral-token',
          textOnly: false,
        },
        sessionState: {
          billingMode: 'byo' as const,
          expiresAtMs: null,
          leaseId: null,
        },
      },
    }));
    const preparation = {
      isSelected: vi.fn(() => true),
      prepare: prepareSessionStart,
      buildStartConfig: vi.fn(({ prepared }: any) => ({
        conversationToken: prepared.sessionConfig.token,
        textOnly: prepared.sessionConfig.textOnly,
      })),
    };
    const lifecycle = {
      prepared: vi.fn(),
      releasePrepared: vi.fn(async () => {}),
      started: vi.fn(),
      ended: vi.fn(async () => {}),
    };
    const runtime = createElevenLabsProtocolAdapter({
      preparation,
      lifecycle,
      eventMapper: createElevenLabsEventMapper(),
      onDiagnosticError: vi.fn(),
      rememberHostedConversation: vi.fn(),
    });

    await expect(runtime.adapter.prepare({
      controlSessionId: 'control-1',
      attemptId: 1,
      reason: 'initial',
      request: {
        initialContext: 'context',
        requestedTargetSessionId: 'target-1',
        retryAfterPaywall: false,
        textOnly: false,
      },
      platform: 'web',
      providerConfig: {},
      accountOperations: { request: vi.fn() },
      providerConversation: null,
      hostedConversation: null,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'prepared',
      session: {
        config: { conversationToken: 'ephemeral-token', textOnly: false },
        safeMetadata: {
          billingMode: 'byo',
          expiresAtMs: null,
        },
      },
    });
    expect(prepareSessionStart).toHaveBeenCalledWith(expect.objectContaining({
      controlSessionId: 'control-1',
      initialContext: 'context',
      requestedTargetSessionId: 'target-1',
      retryAfterPaywall: false,
      textOnly: false,
    }));

    await runtime.adapter.prepare({
      controlSessionId: 'control-1',
      attemptId: 2,
      reason: 'initial',
      request: {
        initialContext: 'replacement context',
        requestedTargetSessionId: 'target-1',
        retryAfterPaywall: false,
        textOnly: false,
      },
      platform: 'web',
      providerConfig: {},
      accountOperations: { request: vi.fn() },
      providerConversation: null,
      hostedConversation: null,
      signal: new AbortController().signal,
    });
    await runtime.adapter.releasePrepared?.({
      controlSessionId: 'control-1',
      attemptId: 1,
      reason: { code: 'replaced' },
    });
    expect(lifecycle.releasePrepared).toHaveBeenCalledWith(1, expect.any(Object));

    runtime.handleSessionIdentity({ controlSessionId: 'control-1', conversationId: 'conversation-1' });
    expect(lifecycle.started).toHaveBeenCalledWith(expect.objectContaining({
      controlSessionId: 'control-1',
      conversationId: 'conversation-1',
      attemptId: 2,
    }));
    await runtime.endSession();
    expect(lifecycle.ended).toHaveBeenCalledTimes(1);
  });

  it('keeps raw ElevenLabs event semantics in the provider leaf and emits canonical transcript events', () => {
    const runtime = createElevenLabsProtocolAdapter({
      preparation: {
        isSelected: vi.fn(() => true),
        prepare: vi.fn(),
        buildStartConfig: vi.fn(),
      },
      lifecycle: {
        prepared: vi.fn(),
        releasePrepared: vi.fn(async () => {}),
        started: vi.fn(),
        ended: vi.fn(async () => {}),
      },
      eventMapper: createElevenLabsEventMapper(),
      onDiagnosticError: vi.fn(),
      rememberHostedConversation: vi.fn(),
    });
    runtime.adapter.prepare({
      controlSessionId: 'control-events',
      attemptId: 1,
      reason: 'initial',
      request: {},
      platform: 'web',
      providerConfig: {},
      accountOperations: { request: vi.fn() },
      providerConversation: null,
      hostedConversation: null,
      signal: new AbortController().signal,
    }).catch(() => {});
    expect(runtime.adapter.decodeControl({ type: 'elevenlabs.mode', mode: 'speaking' }))
      .toEqual([{ type: 'assistant_output_started' }]);
    expect(runtime.adapter.decodeControl({ type: 'elevenlabs.mode', mode: 'listening' }))
      .toEqual([{ type: 'assistant_output_stopped' }]);
    expect(runtime.adapter.decodeControl({
      type: 'future.provider.event',
      token: 'sentinel-secret-token',
      transcript: 'sentinel-private-transcript',
    })).toEqual([]);
  });

  it('discards prepared provider state when the controller tears down before session identity', async () => {
    const lifecycle = {
      prepared: vi.fn(),
      releasePrepared: vi.fn(async () => {}),
      started: vi.fn(),
      ended: vi.fn(async () => {}),
    };
    const runtime = createElevenLabsProtocolAdapter({
      preparation: {
        isSelected: vi.fn(() => true),
        prepare: vi.fn(async () => ({
          kind: 'prepared' as const,
          session: {
            sessionConfig: { token: 'ephemeral-token' },
            sessionState: { billingMode: 'byo' as const, expiresAtMs: null, leaseId: null },
          },
        })),
        buildStartConfig: vi.fn(() => ({ conversationToken: 'ephemeral-token' })),
      },
      lifecycle,
      eventMapper: createElevenLabsEventMapper(),
      onDiagnosticError: vi.fn(),
      rememberHostedConversation: vi.fn(),
    });
    await runtime.adapter.prepare({
      controlSessionId: 'never-connected',
      attemptId: 1,
      reason: 'initial',
      request: {},
      platform: 'web',
      providerConfig: {},
      accountOperations: { request: vi.fn() },
      providerConversation: null,
      hostedConversation: null,
      signal: new AbortController().signal,
    });

    await runtime.adapter.releasePrepared?.({
      controlSessionId: 'never-connected',
      attemptId: 1,
      reason: { code: 'error' },
    });
    runtime.handleSessionIdentity({
      controlSessionId: 'never-connected',
      conversationId: 'late-identity',
    });

    expect(lifecycle.started).not.toHaveBeenCalled();
  });
});
