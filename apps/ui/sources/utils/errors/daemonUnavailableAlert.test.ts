import { describe, expect, it, vi } from 'vitest';

const modalAlertSpy = vi.hoisted(() => vi.fn((..._args: unknown[]) => {}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: modalAlertSpy,
    },
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => {
        if (key === 'status.lastSeen') return `status.lastSeen:${String(params?.time ?? '')}`;
        if (key === 'time.minutesAgo') return `time.minutesAgo:${String(params?.count ?? '')}`;
        if (key === 'time.hoursAgo') return `time.hoursAgo:${String(params?.count ?? '')}`;
        if (key === 'sessionHistory.daysAgo') return `sessionHistory.daysAgo:${String(params?.count ?? '')}`;
        return key;
    },
}));

describe('daemonUnavailableAlert', () => {
    it('shows a translated alert with machine status and Retry/Cancel buttons', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { showDaemonUnavailableAlert } = await import('./daemonUnavailableAlert');

        const onRetry = vi.fn();
        showDaemonUnavailableAlert({
            titleKey: 'errors.daemonUnavailableTitle',
            bodyKey: 'errors.daemonUnavailableBody',
            machine: {
                active: false,
                activeAt: Date.now() - 5 * 60_000,
                metadata: { host: 'devbox' },
            },
            onRetry,
        });

        expect(modalAlertSpy).toHaveBeenCalled();
        const args = modalAlertSpy.mock.calls[0] ?? [];
        expect(args[0]).toBe('errors.daemonUnavailableTitle');
        expect(String(args[1] ?? '')).toContain('errors.daemonUnavailableBody');
        expect(String(args[1] ?? '')).toContain('status.lastSeen:time.minutesAgo:5');

        const buttons = args[2] as any[];
        expect(Array.isArray(buttons)).toBe(true);
        expect(buttons.some((b) => b?.text === 'common.retry' && typeof b?.onPress === 'function')).toBe(true);
        expect(buttons.some((b) => b?.text === 'common.cancel')).toBe(true);
    });

    it('guards Retry when shouldContinue returns false', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { showDaemonUnavailableAlert } = await import('./daemonUnavailableAlert');

        const onRetry = vi.fn();
        showDaemonUnavailableAlert({
            titleKey: 'errors.daemonUnavailableTitle',
            bodyKey: 'errors.daemonUnavailableBody',
            onRetry,
            shouldContinue: () => false,
        });

        const args = modalAlertSpy.mock.calls[0] ?? [];
        const buttons = args[2] as any[];
        const retry = buttons.find((b) => b?.text === 'common.retry');
        expect(typeof retry?.onPress).toBe('function');

        retry.onPress();
        expect(onRetry).not.toHaveBeenCalled();
    });

    it('shows an alert for RPC method-not-available failure objects (code/message)', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { tryShowDaemonUnavailableAlertForRpcFailure, DAEMON_UNAVAILABLE_RPC_ERROR_CODE } = await import('./daemonUnavailableAlert');

        const onRetry = vi.fn();
        const shown = tryShowDaemonUnavailableAlertForRpcFailure({
            rpcErrorCode: DAEMON_UNAVAILABLE_RPC_ERROR_CODE,
            message: 'RPC method not available',
            onRetry,
        });

        expect(shown).toBe(true);
        expect(modalAlertSpy).toHaveBeenCalled();
    });

    it('does not match by message when a non-daemon rpcErrorCode is present on an Error', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { tryShowDaemonUnavailableAlertForRpcError } = await import('./daemonUnavailableAlert');

        const err = Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'SOME_OTHER_CODE' });
        const shown = tryShowDaemonUnavailableAlertForRpcError({
            error: err,
            onRetry: vi.fn(),
        });

        expect(shown).toBe(false);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('does not match by message when a non-daemon rpcErrorCode is present', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { tryShowDaemonUnavailableAlertForRpcFailure } = await import('./daemonUnavailableAlert');

        const shown = tryShowDaemonUnavailableAlertForRpcFailure({
            rpcErrorCode: 'SOME_OTHER_CODE',
            message: 'RPC method not available',
            onRetry: vi.fn(),
        });

        expect(shown).toBe(false);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('returns false and does not alert for non-RPC method-not-available errors', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { tryShowDaemonUnavailableAlertForRpcError, tryShowDaemonUnavailableAlertForRpcFailure } = await import('./daemonUnavailableAlert');

        const shown = tryShowDaemonUnavailableAlertForRpcError({
            error: new Error('boom'),
            onRetry: vi.fn(),
        });

        expect(shown).toBe(false);
        expect(modalAlertSpy).not.toHaveBeenCalled();

        const shown2 = tryShowDaemonUnavailableAlertForRpcFailure({
            rpcErrorCode: 'OTHER',
            message: 'boom',
            onRetry: vi.fn(),
        });
        expect(shown2).toBe(false);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });
});
