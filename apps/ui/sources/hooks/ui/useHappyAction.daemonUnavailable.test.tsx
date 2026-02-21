import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.hoisted(() => vi.fn((..._args: unknown[]) => {}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: modalAlertSpy,
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('useHappyAction (daemon unavailable)', () => {
    it('shows a daemon-unavailable alert with Retry when action throws RPC method-not-available', async () => {
        vi.resetModules();
        modalAlertSpy.mockClear();

        const action = vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }))
            .mockResolvedValueOnce(undefined);

        const { useHappyAction } = await import('./useHappyAction');

        let doAction: null | (() => void) = null;
        function Test() {
            const [_loading, run] = useHappyAction(action);
            doAction = run;
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
        });
        if (!doAction) throw new Error('expected doAction to be set');

        await act(async () => {
            doAction!();
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(modalAlertSpy).toHaveBeenCalled();
        const [title, message, buttons] = modalAlertSpy.mock.calls[0] ?? [];
        expect(title).toBe('errors.daemonUnavailableTitle');
        expect(String(message)).toContain('errors.daemonUnavailableBody');
        expect(Array.isArray(buttons)).toBe(true);
        const retry = (buttons as any[]).find((b) => b?.text === 'common.retry');
        expect(retry).toBeTruthy();

        await act(async () => {
            retry.onPress();
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(action).toHaveBeenCalledTimes(2);
        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
    });

    it('does not retry after unmount (retry handler is mounted-safe)', async () => {
        vi.resetModules();
        modalAlertSpy.mockClear();

        const action = vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }))
            .mockResolvedValueOnce(undefined);

        const { useHappyAction } = await import('./useHappyAction');

        let doAction: null | (() => void) = null;
        function Test() {
            const [_loading, run] = useHappyAction(action);
            doAction = run;
            return null;
        }

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Test));
        });
        if (!doAction) throw new Error('expected doAction to be set');

        await act(async () => {
            doAction!();
            await new Promise((r) => setTimeout(r, 0));
        });

        const [_title, _message, buttons] = modalAlertSpy.mock.calls[0] ?? [];
        const retry = (buttons as any[]).find((b) => b?.text === 'common.retry');
        expect(retry).toBeTruthy();

        act(() => {
            tree!.unmount();
        });

        await act(async () => {
            retry.onPress();
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(action).toHaveBeenCalledTimes(1);
    });

    it('falls back to unknown error for non-RPC errors', async () => {
        vi.resetModules();
        modalAlertSpy.mockClear();

        const action = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('boom'));
        const { useHappyAction } = await import('./useHappyAction');

        let doAction: null | (() => void) = null;
        function Test() {
            const [_loading, run] = useHappyAction(action);
            doAction = run;
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
        });
        if (!doAction) throw new Error('expected doAction to be set');

        await act(async () => {
            doAction!();
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(modalAlertSpy).toHaveBeenCalledWith(
            'common.error',
            'errors.unknownError',
            expect.any(Array),
        );
    });
});
