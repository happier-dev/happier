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
    const lifecycle = { started: vi.fn(), ended: vi.fn(async () => {}) };
    const runtime = createElevenLabsProtocolAdapter({
      preparation,
      lifecycle,
      eventMapper: createElevenLabsEventMapper(),
      onDiagnosticError: vi.fn(),
      getSettings: () => ({ voice: { providerId: 'realtime_elevenlabs' } }),
    });

    await expect(runtime.adapter.prepare({
      controlSessionId: 'control-1',
      reason: 'initial',
      request: {
        initialContext: 'context',
        requestedTargetSessionId: 'target-1',
        retryAfterPaywall: false,
        textOnly: false,
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'prepared',
      session: {
        config: { conversationToken: 'ephemeral-token', textOnly: false },
        safeMetadata: {
          billingMode: 'byo',
          expiresAtMs: null,
          leaseId: null,
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

    runtime.handleSessionIdentity({ controlSessionId: 'control-1', conversationId: 'conversation-1' });
    expect(lifecycle.started).toHaveBeenCalledWith(expect.objectContaining({
      controlSessionId: 'control-1',
      conversationId: 'conversation-1',
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
      lifecycle: { started: vi.fn(), ended: vi.fn(async () => {}) },
      eventMapper: createElevenLabsEventMapper(),
      onDiagnosticError: vi.fn(),
      getSettings: () => ({}),
    });
    runtime.adapter.prepare({
      controlSessionId: 'control-events',
      reason: 'initial',
      request: {},
      signal: new AbortController().signal,
    }).catch(() => {});
    expect(runtime.adapter.decodeControl({ type: 'elevenlabs.mode', mode: 'speaking' })).toEqual([
      { type: 'provider_event', event: { type: 'elevenlabs.mode', mode: 'speaking' } },
    ]);
  });

  it('discards prepared provider state when the controller tears down before session identity', async () => {
    const lifecycle = { started: vi.fn(), ended: vi.fn(async () => {}) };
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
      getSettings: () => ({}),
    });
    await runtime.adapter.prepare({
      controlSessionId: 'never-connected',
      reason: 'initial',
      request: {},
      signal: new AbortController().signal,
    });

    await runtime.adapter.releasePrepared?.({
      controlSessionId: 'never-connected',
      reason: { code: 'error' },
    });
    runtime.handleSessionIdentity({
      controlSessionId: 'never-connected',
      conversationId: 'late-identity',
    });

    expect(lifecycle.started).not.toHaveBeenCalled();
  });
});
