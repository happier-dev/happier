import { describe, expect, it, vi } from 'vitest';

import { PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE } from '../bridgeExtension/piBridgeExtensionEnv';
import { parsePiContextTelemetryFromSessionStats } from './piContextTelemetryMarker';

import { PiRpcBackend } from './PiRpcBackend';

type PrivateContextTelemetryBackend = {
  process: unknown;
  latestContextTelemetry: { used: number; size: number } | null;
  lastPublishedUsageKey: string | null;
  usageStatsPublishChain: Promise<void>;
  handleStderrLine(line: string): void;
  handleEvent(event: Record<string, unknown>): void;
  emitMessage(message: unknown): void;
  getSessionStats(): Promise<unknown>;
  publishUsageStatsBestEffort(): Promise<void>;
  scheduleUsageStatsPublish(): Promise<void>;
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

  it('prefers stats.contextUsage over the stderr marker when both are present', async () => {
    const backend = createBackendForContextTelemetry();
    const priv = backend as unknown as PrivateContextTelemetryBackend;
    const emitSpy = vi.spyOn(priv, 'emitMessage');
    priv.getSessionStats = async () => ({
      sessionId: 'pi-session-1',
      assistantMessages: 3,
      tokens: { input: 50, output: 10 },
      contextUsage: { tokens: 555, contextWindow: 999, percent: 55.5 },
    });
    priv.handleStderrLine(`{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":1000,"size":200000}`);

    await priv.publishUsageStatsBestEffort();

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect((emitSpy.mock.calls[0][0] as Record<string, unknown>).tokens).toMatchObject({
      context_used_tokens: 555,
      context_window_tokens: 999,
    });
  });

  it('treats explicit null stats.contextUsage as authoritative while absent usage may use the marker', async () => {
    expect(parsePiContextTelemetryFromSessionStats({ contextUsage: { tokens: null, contextWindow: 200000 } })).toBeNull();
    expect(parsePiContextTelemetryFromSessionStats({})).toBeNull();
    expect(parsePiContextTelemetryFromSessionStats({ contextUsage: { tokens: 5, contextWindow: 0 } })).toBeNull();

    const backend = createBackendForContextTelemetry();
    const priv = backend as unknown as PrivateContextTelemetryBackend;
    const emitSpy = vi.spyOn(priv, 'emitMessage');
    priv.getSessionStats = async () => ({
      sessionId: 'pi-session-1',
      assistantMessages: 3,
      tokens: { input: 50 },
      contextUsage: { tokens: null, contextWindow: 200000, percent: null },
    });
    priv.handleStderrLine(`{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":777,"size":200000}`);

    await priv.publishUsageStatsBestEffort();

    expect((emitSpy.mock.calls[0][0] as Record<string, unknown>).tokens).toEqual({ input: 50 });

    priv.lastPublishedUsageKey = null;
    priv.getSessionStats = async () => ({
      sessionId: 'pi-session-1',
      assistantMessages: 4,
      tokens: { input: 51 },
    });
    await priv.publishUsageStatsBestEffort();
    expect((emitSpy.mock.calls[1][0] as Record<string, unknown>).tokens).toMatchObject({
      context_used_tokens: 777,
    });
  });

  it('invalidates cached bridge telemetry when compaction starts', () => {
    const backend = createBackendForContextTelemetry();
    const priv = backend as unknown as PrivateContextTelemetryBackend;
    priv.handleStderrLine(`{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":777,"size":200000}`);

    priv.handleEvent({ type: 'compaction_start', reason: 'manual' });

    expect(priv.latestContextTelemetry).toBeNull();
  });

  it('publishes immediately at assistant message_end (before tool calls run), not only at idle', async () => {
    const backend = createBackendForContextTelemetry();
    const priv = backend as unknown as PrivateContextTelemetryBackend;
    const emitSpy = vi.spyOn(priv, 'emitMessage');
    priv.getSessionStats = async () => ({
      sessionId: 'pi-session-1',
      assistantMessages: 4,
      tokens: { input: 100, output: 20 },
      contextUsage: { tokens: 1234, contextWindow: 128000, percent: 1 },
    });

    // An assistant message_end carrying a tool_use: the fresh context is known NOW, while
    // the slow tool has not even started. Mid-turn publishes are gated on bridge telemetry
    // being present, so feed a marker first. (Drain the serialized publish chain.)
    priv.handleStderrLine(`{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":1234,"size":128000}`);
    priv.handleEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash' }] },
    });
    await priv.usageStatsPublishChain;

    expect(emitSpy).toHaveBeenCalledTimes(1);
    const message = emitSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(message.type).toBe('token-count');
    expect(message.tokens).toMatchObject({
      context_used_tokens: 1234,
      context_window_tokens: 128000,
    });
  });

  it('publishes when the stderr telemetry marker follows assistant message_end', async () => {
    const backend = createBackendForContextTelemetry();
    const priv = backend as unknown as PrivateContextTelemetryBackend;
    const emitSpy = vi.spyOn(priv, 'emitMessage');
    priv.getSessionStats = async () => ({
      sessionId: 'pi-session-1',
      assistantMessages: 4,
      tokens: { input: 100, output: 20 },
    });

    priv.handleEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash' }] },
    });
    priv.handleStderrLine(`{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":1234,"size":128000}`);
    await priv.usageStatsPublishChain;

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect((emitSpy.mock.calls[0][0] as Record<string, unknown>).tokens).toMatchObject({
      context_used_tokens: 1234,
      context_window_tokens: 128000,
    });
  });

  it('does not publish on user message_end events', async () => {
    const backend = createBackendForContextTelemetry();
    const priv = backend as unknown as PrivateContextTelemetryBackend;
    const emitSpy = vi.spyOn(priv, 'emitMessage');
    const statsSpy = vi.spyOn(priv, 'getSessionStats');

    await priv.handleEvent({ type: 'message_end', message: { role: 'user', content: [] } });

    expect(emitSpy).not.toHaveBeenCalled();
    expect(statsSpy).not.toHaveBeenCalled();
  });
});
