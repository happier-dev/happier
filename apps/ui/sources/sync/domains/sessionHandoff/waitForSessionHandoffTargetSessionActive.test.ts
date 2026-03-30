import { describe, expect, it, vi } from 'vitest';

describe('waitForSessionHandoffTargetSessionActive', () => {
    it('keeps hydrating the session until it becomes active again', async () => {
        const ensureSessionVisible = vi.fn(async () => {});
        const sleep = vi.fn<(delayMs: number) => Promise<void>>(async () => {});
        let nowMs = 0;
        const readSession = vi
            .fn()
            .mockImplementationOnce(() => ({ active: false }))
            .mockImplementationOnce(() => ({ active: true }));

        const { waitForSessionHandoffTargetSessionActive } = await import('./waitForSessionHandoffTargetSessionActive');
        const result = await waitForSessionHandoffTargetSessionActive({
            sessionId: 'sess_1',
            ensureSessionVisible,
            readSession,
            timeoutMs: 5_000,
            pollIntervalMs: 250,
            now: () => nowMs,
            sleep: async (delayMs) => {
                nowMs += delayMs;
                await sleep(delayMs);
            },
        });

        expect(result).toEqual({ ok: true });
        expect(ensureSessionVisible).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('fails when the session never becomes active within the timeout', async () => {
        const ensureSessionVisible = vi.fn(async () => {});
        let nowMs = 0;

        const { waitForSessionHandoffTargetSessionActive } = await import('./waitForSessionHandoffTargetSessionActive');
        const result = await waitForSessionHandoffTargetSessionActive({
            sessionId: 'sess_2',
            ensureSessionVisible,
            readSession: () => ({ active: false }),
            timeoutMs: 1_000,
            pollIntervalMs: 250,
            now: () => nowMs,
            sleep: async (delayMs) => {
                nowMs += delayMs;
            },
        });

        expect(result).toEqual({
            ok: false,
            error: 'Timed out waiting for session handoff target session to become active',
        });
        expect(ensureSessionVisible).toHaveBeenCalledTimes(4);
    });

    it('keeps hydrating until the session rebinds to the selected target machine', async () => {
        const ensureSessionVisible = vi.fn(async () => {});
        const sleep = vi.fn<(delayMs: number) => Promise<void>>(async () => {});
        let nowMs = 0;
        const readSession = vi.fn(() => ({ active: true }));
        const readTargetMachineId = vi
            .fn<() => string | null>()
            .mockImplementationOnce(() => 'machine_source')
            .mockImplementationOnce(() => 'machine_target');

        const { waitForSessionHandoffTargetSessionActive } = await import('./waitForSessionHandoffTargetSessionActive');
        const result = await waitForSessionHandoffTargetSessionActive({
            sessionId: 'sess_3',
            ensureSessionVisible,
            readSession,
            readTargetMachineId,
            targetMachineId: 'machine_target',
            timeoutMs: 5_000,
            pollIntervalMs: 250,
            now: () => nowMs,
            sleep: async (delayMs) => {
                nowMs += delayMs;
                await sleep(delayMs);
            },
        });

        expect(result).toEqual({ ok: true });
        expect(ensureSessionVisible).toHaveBeenCalledTimes(2);
        expect(readSession).toHaveBeenCalledTimes(2);
        expect(readTargetMachineId).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
    });
});
