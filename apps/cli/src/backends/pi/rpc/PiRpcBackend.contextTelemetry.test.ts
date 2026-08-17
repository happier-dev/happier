import { describe, expect, it, vi } from 'vitest';

import { PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE } from '../bridgeExtension/piBridgeExtensionEnv';

import { PiRpcBackend } from './PiRpcBackend';

type PrivateContextTelemetryBackend = {
  process: unknown;
  latestContextTelemetry: { used: number; size: number } | null;
  lastPublishedUsageKey: string | null;
  handleStderrLine(line: string): void;
  emitMessage(message: unknown): void;
  getSessionStats(): Promise<unknown>;
  publishUsageStatsBestEffort(): Promise<void>;
};

function createBackendForContextTelemetry(): PiRpcBackend {
  const backend = new PiRpcBackend({
    cwd: '/tmp',
    command: 'pi',
    args: [],
    env: {},
    happierSessionId: 'sess_pi_ctx_1',
  });
  // publishUsageStatsBestEffort early-returns without a live child process handle.
  (backend as unknown as PrivateContextTelemetryBackend).process = { pid: 1 } as never;
  return backend;
}

describe('PiRpcBackend context telemetry markers', () => {
  it('stores a well-formed marker and suppresses terminal-output for it', () => {
    const backend = createBackendForContextTelemetry();
    const priv = backend as unknown as PrivateContextTelemetryBackend;
    const emitSpy = vi.spyOn(priv, 'emitMessage');

    priv.handleStderrLine(`{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":38421,"size":200000}`);
    expect(priv.latestContextTelemetry).toEqual({ used: 38421, size: 200000 });
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('ignores non-marker stderr lines (they flow through the normal path)', () => {
    const backend = createBackendForContextTelemetry();
    const priv = backend as unknown as PrivateContextTelemetryBackend;
    priv.handleStderrLine('plain diagnostic line');
    expect(priv.latestContextTelemetry).toBeNull();
  });

  it('merges stored telemetry into the published token-count message', async () => {
    const backend = createBackendForContextTelemetry();
    const priv = backend as unknown as PrivateContextTelemetryBackend;
    const emitSpy = vi.spyOn(priv, 'emitMessage');
    priv.getSessionStats = async () => ({
      sessionId: 'pi-session-1',
      assistantMessages: 7,
      tokens: { input: 100, output: 40, cacheRead: 500, cacheWrite: 60, total: 700 },
      cost: 0.25,
    });

    priv.handleStderrLine(`{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":38421,"size":200000}`);
    await priv.publishUsageStatsBestEffort();

    expect(emitSpy).toHaveBeenCalledTimes(1);
    const message = emitSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(message.type).toBe('token-count');
    expect(message.key).toBe('pi:pi-session-1:7:ctx38421/200000');
    expect(message.tokens).toEqual({
      input: 100,
      output: 40,
      cache_read: 500,
      cache_creation: 60,
      total: 700,
      context_used_tokens: 38421,
      context_window_tokens: 200000,
    });
    expect(message.cost).toEqual({ total: 0.25 });
  });

  it('republishes when the context changes but the assistant-message counter does not', async () => {
    const backend = createBackendForContextTelemetry();
    const priv = backend as unknown as PrivateContextTelemetryBackend;
    const emitSpy = vi.spyOn(priv, 'emitMessage');
    priv.getSessionStats = async () => ({
      sessionId: 'pi-session-1',
      assistantMessages: 7,
      tokens: { input: 100, output: 40 },
    });

    priv.handleStderrLine(`{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":1000,"size":200000}`);
    await priv.publishUsageStatsBestEffort();
    priv.handleStderrLine(`{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":1200,"size":200000}`);
    await priv.publishUsageStatsBestEffort();

    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect((emitSpy.mock.calls[1][0] as Record<string, unknown>).tokens).toMatchObject({
      context_used_tokens: 1200,
    });
  });

  it('dedupes identical stats+telemetry across publishes', async () => {
    const backend = createBackendForContextTelemetry();
    const priv = backend as unknown as PrivateContextTelemetryBackend;
    const emitSpy = vi.spyOn(priv, 'emitMessage');
    priv.getSessionStats = async () => ({
      sessionId: 'pi-session-1',
      assistantMessages: 7,
      tokens: { input: 100 },
    });

    priv.handleStderrLine(`{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":1000,"size":200000}`);
    await priv.publishUsageStatsBestEffort();
    await priv.publishUsageStatsBestEffort();

    expect(emitSpy).toHaveBeenCalledTimes(1);
  });
});
