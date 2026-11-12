import { describe, expect, it, vi } from 'vitest';

import { createRealtimeToolBarrierForVoiceHandlers } from './defaultRealtimeToolBarrier';
import { resolveVoiceToolEffectClass } from './handlers';

function call(overrides: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    responseId: 'response-1',
    callId: 'call-1',
    toolName: 'listMachines',
    order: 0,
    arguments: { limit: 50 },
    ...overrides,
  };
}

describe('default realtime tool barrier integration', () => {
  it.each(['direct', 'generic'] as const)('dispatches the published decoder input rather than raw scalar strings (%s)', async transport => {
    let dispatched: unknown;
    const toolName = transport === 'direct' ? 'listSessions' : 'action_execute';
    const barrier = createRealtimeToolBarrierForVoiceHandlers({
      handlers: { [toolName]: async input => {
        dispatched = input;
        return JSON.stringify(transport === 'direct' ? { ok: true, sessions: [] }
          : { ok: true, result: { sessions: [] } });
      } },
      readRedactionPrefs: () => ({ shareFilePaths: false, shareSessionSummary: false, sharePermissionRequests: false }),
      submitResults: async () => {}, continueResponse: async () => {},
    });
    try {
      const result = await barrier.run({ responseId: 'response-1', calls: [call({ toolName,
        arguments: transport === 'direct' ? { limit: '10' } : { actionId: 'session.list', input: { limit: '10' } },
      })] });
      expect(result.results[0]?.status).toBe('success');
      expect(dispatched).toEqual(transport === 'direct' ? { limit: 10 }
        : { actionId: 'session.list', input: { limit: 10 } });
    } finally { barrier.dispose(); }
  });

  it('refuses generic execution on an attached Agent current-UI-only surface', async () => {
    const handler = vi.fn(async () => JSON.stringify({ ok: true, result: {} }));
    const barrier = createRealtimeToolBarrierForVoiceHandlers({
      handlers: { action_execute: handler }, exposure: 'current_ui_only',
      readRedactionPrefs: () => ({ shareFilePaths: true, shareSessionSummary: true, sharePermissionRequests: true }),
      submitResults: async () => {}, continueResponse: async () => {},
    });
    const result = await barrier.run({ responseId: 'response-1', calls: [call({ toolName: 'action_execute',
      arguments: { actionId: 'ui.voice_global.reset', input: {} } })] });
    expect(result.results[0]).toMatchObject({ status: 'error', errorCode: 'invalid_tool_call' });
    expect(handler).not.toHaveBeenCalled();
    barrier.dispose();
  });
  it('classifies provider tools from the canonical ActionSpec side-effect owner', () => {
    expect(resolveVoiceToolEffectClass('listMachines')).toBe('read_only');
    expect(resolveVoiceToolEffectClass('sendSessionMessage')).toBe('external');
    expect(resolveVoiceToolEffectClass('unknownVoiceTool')).toBe('external');
  });

  it('applies target Action privacy to generic reads after handler completion', async () => {
    const barrier = createRealtimeToolBarrierForVoiceHandlers({
      handlers: { action_execute: async () => JSON.stringify({ ok: true, items: [{ machineId: 'private-machine' }] }) },
      readRedactionPrefs: () => ({ shareFilePaths: false, shareSessionSummary: false,
        sharePermissionRequests: false, shareDeviceInventory: false, shareRecentMessages: false }),
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
    });
    const result = await barrier.run({ responseId: 'response-1', calls: [call({ toolName: 'action_execute',
      arguments: { actionId: 'machines.list', input: {} } })] });
    expect(result.results).toEqual([expect.objectContaining({ status: 'success',
      output: { ok: false, errorCode: 'privacy_disabled', error: 'privacy_disabled' } })]);
    expect(JSON.stringify(result)).not.toContain('private-machine');
  });

  it('uses canonical handlers and redacts their parsed result before the provider boundary', async () => {
    const submitResults = vi.fn(async () => undefined);
    const handler = vi.fn(async () => JSON.stringify({
      ok: true,
      title: 'private session summary',
      locationLabel: '/Users/alice/private-repo',
      machineId: 'machine-1',
    }));
    const barrier = createRealtimeToolBarrierForVoiceHandlers({
      handlers: { listMachines: handler },
      readRedactionPrefs: () => ({
        shareFilePaths: false,
        shareSessionSummary: false,
        sharePermissionRequests: false,
        shareDeviceInventory: true,
        shareRecentMessages: true,
      }),
      submitResults,
      continueResponse: async () => undefined,
    });

    const result = await barrier.run({ responseId: 'response-1', calls: [call()] });
    expect(handler).toHaveBeenCalledWith(
      { limit: 50 },
      expect.objectContaining({ callId: 'call-1', signal: expect.any(AbortSignal) }),
    );
    expect(result.results).toEqual([
      expect.objectContaining({
        status: 'success',
        output: { ok: true, machineId: 'machine-1' },
      }),
    ]);
    expect(JSON.stringify(submitResults.mock.calls)).not.toContain('private session summary');
    expect(JSON.stringify(submitResults.mock.calls)).not.toContain('/Users/alice');
  });

  it('passes the realtime call identity and cancellation signal only through the invocation context', async () => {
    const handler = vi.fn(async () => JSON.stringify({ ok: true }));
    const barrier = createRealtimeToolBarrierForVoiceHandlers({
      handlers: { listMachines: handler },
      readRedactionPrefs: () => ({
        shareFilePaths: true,
        shareSessionSummary: true,
        sharePermissionRequests: true,
        shareDeviceInventory: true,
        shareRecentMessages: true,
      }),
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
    });

    await barrier.run({ responseId: 'response-1', calls: [call()] });

    expect(handler).toHaveBeenCalledWith(
      { limit: 50 },
      expect.objectContaining({
        callId: 'call-1',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('turns canonical handler failures into safe typed results without leaking messages', async () => {
    const barrier = createRealtimeToolBarrierForVoiceHandlers({
      handlers: {
        listMachines: async () => JSON.stringify({
          ok: false,
          errorCode: 'machine_unavailable',
          errorMessage: '/Users/alice/private raw provider detail',
        }),
      },
      readRedactionPrefs: () => ({
        shareFilePaths: false,
        shareSessionSummary: false,
        sharePermissionRequests: false,
        shareDeviceInventory: true,
        shareRecentMessages: true,
      }),
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
    });

    const result = await barrier.run({ responseId: 'response-1', calls: [call()] });
    expect(result.results).toEqual([
      expect.objectContaining({ status: 'error', errorCode: 'machine_unavailable' }),
    ]);
    expect(JSON.stringify(result)).not.toContain('/Users/alice');
    expect(JSON.stringify(result)).not.toContain('raw provider detail');
  });

  it('rechecks inventory privacy after handler completion before submitting the result', async () => {
    const submitResults = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrierForVoiceHandlers({
      handlers: {
        listMachines: async () => JSON.stringify({
          ok: true,
          items: [{ machineId: 'machine_secret', label: 'Private workstation' }],
        }),
      },
      readRedactionPrefs: () => ({
        shareFilePaths: true,
        shareSessionSummary: true,
        sharePermissionRequests: true,
        shareDeviceInventory: false,
        shareRecentMessages: true,
      }),
      submitResults,
      continueResponse: async () => undefined,
    });

    const result = await barrier.run({ responseId: 'response-1', calls: [call()] });

    expect(JSON.stringify(result)).not.toContain('machine_secret');
    expect(JSON.stringify(result)).not.toContain('Private workstation');
    expect(result.results).toEqual([
      expect.objectContaining({
        status: 'success',
        output: {
          ok: false,
          errorCode: 'privacy_disabled',
          errorMessage: 'privacy_disabled',
        },
      }),
    ]);
    expect(JSON.stringify(submitResults.mock.calls)).not.toContain('machine_secret');
  });
});
