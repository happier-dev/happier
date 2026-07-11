import { afterEach, describe, expect, it, vi } from 'vitest';

import { createElevenLabsLiveness } from './elevenLabsLiveness.js';

function createInboundWatchdog(input: Readonly<{
  onStall: () => void;
  stallTimeoutMs: number;
  awaitingResponseTimeoutMs: number;
}>) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let awaiting = false;
  const arm = () => {
    if (timer) clearTimeout(timer);
    const timeout = awaiting ? input.awaitingResponseTimeoutMs : active ? input.stallTimeoutMs : 0;
    timer = timeout > 0 ? setTimeout(input.onStall, timeout) : null;
  };
  return {
    start: arm,
    stop: () => { if (timer) clearTimeout(timer); timer = null; active = false; awaiting = false; },
    noteInboundEvent: arm,
    markAwaitingResponse: (value: boolean) => { awaiting = value; arm(); },
    markTurnActive: (value: boolean) => { active = value; arm(); },
  };
}

afterEach(() => vi.useRealTimers());

describe('createElevenLabsLiveness', () => {
  it('detects inbound speaking stalls and outbound mic plateaus without firing while idle', async () => {
    vi.useFakeTimers();
    let now = 0;
    let bytes = 10;
    const onInboundStall = vi.fn();
    const onOutboundPlateau = vi.fn();
    const liveness = createElevenLabsLiveness({
      createInboundWatchdog,
      now: () => now,
      readOutboundBytes: async () => bytes,
      onInboundStall,
      onOutboundPlateau,
      pollMs: 10,
      plateauMs: 20,
      inboundStallMs: 25,
      awaitingResponseMs: 40,
    });

    liveness.connected();
    await vi.advanceTimersByTimeAsync(50);
    expect(onInboundStall).not.toHaveBeenCalled();
    liveness.modeChanged('speaking');
    await vi.advanceTimersByTimeAsync(24);
    expect(onInboundStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onInboundStall).toHaveBeenCalledTimes(1);

    bytes = 20;
    now = 10;
    await vi.advanceTimersByTimeAsync(10);
    now = 31;
    await vi.advanceTimersByTimeAsync(20);
    expect(onOutboundPlateau).toHaveBeenCalledTimes(1);
    liveness.disconnected();
  });

  it('does not treat between-turn listening silence as a stall but bounds an unanswered committed user turn', async () => {
    vi.useFakeTimers();
    const onInboundStall = vi.fn();
    const liveness = createElevenLabsLiveness({
      createInboundWatchdog,
      now: () => 0,
      readOutboundBytes: async () => null,
      onInboundStall,
      onOutboundPlateau: vi.fn(),
      pollMs: 10,
      plateauMs: 20,
      inboundStallMs: 25,
      awaitingResponseMs: 40,
    });
    liveness.connected();
    liveness.modeChanged('listening');
    await vi.advanceTimersByTimeAsync(100);
    expect(onInboundStall).not.toHaveBeenCalled();

    liveness.userTurnCommitted();
    await vi.advanceTimersByTimeAsync(39);
    expect(onInboundStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onInboundStall).toHaveBeenCalledTimes(1);
    liveness.disconnected();
  });
});
