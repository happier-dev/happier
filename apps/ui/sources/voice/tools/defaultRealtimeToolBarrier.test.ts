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
  it('classifies provider tools from the canonical ActionSpec side-effect owner', () => {
    expect(resolveVoiceToolEffectClass('listMachines')).toBe('read_only');
    expect(resolveVoiceToolEffectClass('sendSessionMessage')).toBe('external');
    expect(resolveVoiceToolEffectClass('unknownVoiceTool')).toBe('external');
  });

  it('rejects an undeclared effectful call unless the provider declared stable call/result custody', async () => {
    const handler = vi.fn(async () => JSON.stringify({ ok: true }));
    const deps = {
      handlers: { sendSessionMessage: handler },
      readRedactionPrefs: () => ({
        shareFilePaths: true,
        shareSessionSummary: true,
        sharePermissionRequests: true,
        shareDeviceInventory: true,
        shareRecentMessages: true,
      }),
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
    };

    const noCustody = createRealtimeToolBarrierForVoiceHandlers(deps);
    await expect(noCustody.run({
      responseId: 'response-no-custody',
      calls: [call({
        responseId: 'response-no-custody',
        callId: 'call-no-custody',
        toolName: 'sendSessionMessage',
        arguments: { message: 'hello' },
      })],
    })).resolves.toMatchObject({
      results: [expect.objectContaining({ status: 'denied', errorCode: 'voice_effect_call_custody_unavailable' })],
    });
    expect(handler).not.toHaveBeenCalled();

    const stableCustody = createRealtimeToolBarrierForVoiceHandlers({
      ...deps,
      effectCalls: 'stable_ids',
    });
    await expect(stableCustody.run({
      responseId: 'response-stable-custody',
      calls: [call({
        responseId: 'response-stable-custody',
        callId: 'call-stable-custody',
        toolName: 'sendSessionMessage',
        arguments: { message: 'hello' },
      })],
    })).resolves.toMatchObject({
      results: [expect.objectContaining({ status: 'success' })],
    });
    expect(handler).toHaveBeenCalledTimes(1);
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
