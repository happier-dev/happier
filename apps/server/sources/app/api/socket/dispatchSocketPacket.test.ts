import { afterEach, expect, it, vi } from 'vitest';
import { readWebLatencyRequestId } from '@/utils/webLatencyTrace';
import { dispatchSocketPacket } from './dispatchSocketPacket';

afterEach(() => vi.unstubAllEnvs());

it('correlates concurrent socket producers through their asynchronous handler continuation when tracing is enabled', async () => {
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
    const dispatch = () => new Promise<string | undefined>(resolve => {
        dispatchSocketPacket({ listenerCount: () => 1 }, ['machine-alive', { time: 1 }], () => {
            queueMicrotask(() => resolve(readWebLatencyRequestId()));
        });
    });
    const ids = await Promise.all([dispatch(), dispatch()]);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(readWebLatencyRequestId()).toBeUndefined();
});

it('keeps tracing allocation out of ordinary packets and preserves unknown-method acknowledgement', () => {
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '0');
    const next = vi.fn(() => expect(readWebLatencyRequestId()).toBeUndefined());
    dispatchSocketPacket({ listenerCount: () => 1 }, ['machine-alive'], next);
    expect(next).toHaveBeenCalledOnce();
    const acknowledge = vi.fn();
    dispatchSocketPacket({ listenerCount: () => 0 }, ['unknown', acknowledge], next);
    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ ok: false, method: 'unknown' }));
    expect(next).toHaveBeenCalledOnce();
});

it('preserves a synchronous transport continuation failure with tracing enabled', () => {
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
    const failure = new Error('transport continuation failed');
    expect(() => dispatchSocketPacket({ listenerCount: () => 1 }, ['machine-alive'], () => { throw failure; }))
        .toThrow(failure);
});
