import { describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import {
    createPluginAccountDataEraseRecoveryController,
    type PluginAccountDataEraseRecoveryDependencies,
    type PluginAccountDataEraseRecoveryExecute,
} from './pluginAccountDataEraseRecoveryController';

type TestLifetime = ActiveServerAccountScopeLifetime & Readonly<{
    retire(): void;
}>;

function createLifetime(): TestLifetime {
    let current = true;
    const retireCallbacks = new Set<() => void>();
    return {
        scope: { serverId: 'server-a', accountId: 'account-a' },
        isCurrent: () => current,
        onRetire(callback) {
            if (!current) {
                callback();
                return { dispose() {} };
            }
            retireCallbacks.add(callback);
            return { dispose: () => retireCallbacks.delete(callback) };
        },
        retire() {
            if (!current) return;
            current = false;
            for (const callback of [...retireCallbacks]) callback();
            retireCallbacks.clear();
        },
    };
}

function completedResult(): ActionExecuteResult {
    return {
        ok: true,
        result: {
            status: 'completed',
            settings: { status: 'completed', changed: true },
            data: { status: 'completed', changed: false },
        },
    };
}

function createHarness(params?: Readonly<{
    confirmResults?: readonly boolean[];
    executeResults?: readonly ActionExecuteResult[];
    promptResult?: string | null;
    lifetime?: TestLifetime | null;
}>) {
    const confirms = [...(params?.confirmResults ?? [true])];
    const results = [...(params?.executeResults ?? [completedResult()])];
    const modal = {
        prompt: vi.fn(async () => params?.promptResult ?? null),
        confirm: vi.fn(async () => confirms.shift() ?? false),
        alert: vi.fn(),
    };
    const execute = vi.fn<PluginAccountDataEraseRecoveryExecute>(async () => results.shift() ?? completedResult());
    const lifetime = params && Object.hasOwn(params, 'lifetime')
        ? params.lifetime ?? null
        : createLifetime();
    const captureActiveAccountScopeLifetime = vi.fn(() => lifetime);
    const dependencies = {
        execute,
        modal,
        captureActiveAccountScopeLifetime,
    } as unknown as PluginAccountDataEraseRecoveryDependencies;
    return {
        controller: createPluginAccountDataEraseRecoveryController(dependencies),
        captureActiveAccountScopeLifetime,
        execute,
        modal,
    };
}

describe('createPluginAccountDataEraseRecoveryController', () => {
    it('fails closed before prompting or dispatching when no current Account lifetime is captured', async () => {
        const harness = createHarness({ lifetime: null });

        await harness.controller.eraseKnownPlugin('example.plugin');

        expect(harness.modal.prompt).not.toHaveBeenCalled();
        expect(harness.modal.confirm).not.toHaveBeenCalled();
        expect(harness.execute).not.toHaveBeenCalled();
    });

    it('fails closed before prompting or dispatching from an already-retired Account lifetime', async () => {
        const lifetime = createLifetime();
        lifetime.retire();
        const harness = createHarness({ lifetime });

        await harness.controller.eraseKnownPlugin('example.plugin');

        expect(harness.modal.prompt).not.toHaveBeenCalled();
        expect(harness.modal.confirm).not.toHaveBeenCalled();
        expect(harness.execute).not.toHaveBeenCalled();
    });

    it('does not dispatch an erase Action when the present user cancels confirmation', async () => {
        const harness = createHarness({ confirmResults: [false] });

        await harness.controller.eraseKnownPlugin('example.plugin');

        expect(harness.execute).not.toHaveBeenCalled();
    });

    it('presents a transition-cleanup pending result without re-executing the Action, then allows a distinct later invocation', async () => {
        const harness = createHarness({
            confirmResults: [true, true],
            executeResults: [{
                ok: true,
                result: {
                    status: 'partial',
                    settings: { status: 'completed', changed: true },
                    data: { status: 'pending', reason: 'transition-cleanup' },
                },
            }, completedResult()],
        });

        await harness.controller.eraseKnownPlugin('example.plugin');

        expect(harness.execute).toHaveBeenCalledTimes(1);
        expect(harness.execute).toHaveBeenNthCalledWith(
            1,
            'account.plugins.data.erase',
            { pluginId: 'example.plugin' },
            expect.objectContaining({
                surface: 'ui',
                actionCaller: { kind: 'host' },
                signal: expect.any(AbortSignal),
            }),
        );
        const firstContext = harness.execute.mock.calls[0]?.[2];
        expect(firstContext).not.toHaveProperty('actionRequestId');
        expect(harness.modal.alert).toHaveBeenCalledTimes(1);
        expect(harness.modal.confirm).toHaveBeenCalledTimes(1);
        expect(harness.controller.isPending()).toBe(false);

        await harness.controller.eraseKnownPlugin('example.plugin');

        expect(harness.execute).toHaveBeenCalledTimes(2);
        const retryContext = harness.execute.mock.calls[1]?.[2];
        expect(retryContext).not.toHaveProperty('actionRequestId');
    });

    it('dispatches each independently confirmed erase without a completion nonce', async () => {
        const harness = createHarness({ confirmResults: [true, true] });

        await harness.controller.eraseKnownPlugin('example.plugin');
        await harness.controller.eraseKnownPlugin('example.plugin');

        expect(harness.execute).toHaveBeenCalledTimes(2);
        const firstContext = harness.execute.mock.calls[0]?.[2];
        const secondContext = harness.execute.mock.calls[1]?.[2];
        expect(firstContext).not.toHaveProperty('actionRequestId');
        expect(secondContext).not.toHaveProperty('actionRequestId');
    });

    it('presents a failed result without re-executing the Action in the same invocation', async () => {
        const harness = createHarness({
            confirmResults: [true, true],
            executeResults: [{
                ok: true,
                result: {
                    status: 'failed',
                    settings: { status: 'failed', reason: 'unexpected' },
                    data: { status: 'failed', reason: 'request-rejected' },
                },
            }, completedResult()],
        });

        await harness.controller.eraseKnownPlugin('example.plugin');

        expect(harness.execute).toHaveBeenCalledTimes(1);
        expect(harness.modal.confirm).toHaveBeenCalledTimes(1);
        expect(harness.modal.alert).toHaveBeenCalledTimes(1);
        expect(harness.controller.isPending()).toBe(false);
    });

    it('accepts an orphaned plugin id from the Settings recovery prompt', async () => {
        const harness = createHarness({
            confirmResults: [true],
            promptResult: 'example.orphaned-plugin',
        });

        await harness.controller.eraseOrphanedPlugin();

        expect(harness.execute).toHaveBeenCalledExactlyOnceWith(
            'account.plugins.data.erase',
            { pluginId: 'example.orphaned-plugin' },
            expect.objectContaining({ actionCaller: { kind: 'host' } }),
        );
    });

    it('retires the presentation without showing a stale result after an Account switch', async () => {
        const lifetime = createLifetime();
        const harness = createHarness({
            confirmResults: [true],
            lifetime,
            executeResults: [completedResult()],
        });
        harness.execute.mockImplementationOnce(async () => {
            lifetime.retire();
            return completedResult();
        });

        await harness.controller.eraseKnownPlugin('example.plugin');

        expect(harness.execute).toHaveBeenCalledTimes(1);
        expect(harness.modal.alert).not.toHaveBeenCalled();
    });
});
