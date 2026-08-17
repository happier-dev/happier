import { describe, expect, it, vi } from 'vitest';
import type {
    PluginAccountDataEraseDataArmResultV1,
    PluginAccountDataEraseSettingsArmResultV1,
} from '@happier-dev/protocol';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import type { AccountPluginSecretSettingsEraseResult } from './scopedPluginAccountSecretSettingsAdapter';

import {
    createAccountPluginDataEraseAction,
    type AccountPluginDataEraseActionDependencies,
} from './accountPluginDataEraseAction';

type TestLifetime = ActiveServerAccountScopeLifetime & Readonly<{
    retire(): void;
}>;

function createLifetime(params: Readonly<{
    serverId: string;
    accountId: string;
}>): TestLifetime {
    let current = true;
    const retireCallbacks = new Set<() => void>();
    return {
        scope: { serverId: params.serverId, accountId: params.accountId },
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

function createHarness(params?: Readonly<{
    lifetime?: TestLifetime | null;
    data?: PluginAccountDataEraseDataArmResultV1;
    settings?: AccountPluginSecretSettingsEraseResult;
}>) {
    const lifetime = params?.lifetime ?? createLifetime({ serverId: 'server-a', accountId: 'account-a' });
    const eraseSettings = vi.fn(async (): Promise<AccountPluginSecretSettingsEraseResult> => (
        params?.settings ?? { status: 'completed', changed: true }
    ));
    const eraseData = vi.fn(async (): Promise<PluginAccountDataEraseDataArmResultV1> => (
        params?.data ?? { status: 'completed', changed: true }
    ));
    const captureActiveAccountScopeLifetime = vi.fn(() => lifetime);
    const dependencies = {
        captureActiveAccountScopeLifetime,
        resolveAccountSettingsServerIdentity: vi.fn(() => 'server-identity-a'),
        resolveAccountSettingsTarget: vi.fn((serverIdentityId: string): {
            kind: 'account';
            serverIdentityId: string;
        } => ({
            kind: 'account',
            serverIdentityId,
        })),
        eraseSettings,
        eraseData,
    } satisfies AccountPluginDataEraseActionDependencies;
    return {
        action: createAccountPluginDataEraseAction(dependencies),
        captureActiveAccountScopeLifetime,
        eraseSettings,
        eraseData,
        lifetime,
    };
}

describe('createAccountPluginDataEraseAction', () => {
    it('does not start either erase arm when the host-present action is cancelled', async () => {
        const harness = createHarness();
        const controller = new AbortController();
        controller.abort();

        await expect(harness.action.execute({ pluginId: 'example.plugin' }, { signal: controller.signal })).resolves.toEqual({
            status: 'partial',
            settings: { status: 'pending', reason: 'unavailable' },
            data: { status: 'pending', reason: 'unavailable' },
        });

        expect(harness.eraseSettings).not.toHaveBeenCalled();
        expect(harness.eraseData).not.toHaveBeenCalled();
    });

    it('reruns both idempotent arms on every explicit invocation', async () => {
        const harness = createHarness({ data: { status: 'pending', reason: 'unavailable' } });

        await expect(harness.action.execute({ pluginId: 'example.plugin' })).resolves.toEqual({
            status: 'partial',
            settings: { status: 'completed', changed: true },
            data: { status: 'pending', reason: 'unavailable' },
        });
        harness.eraseSettings.mockResolvedValueOnce({ status: 'completed', changed: false });
        harness.eraseData.mockResolvedValueOnce({ status: 'completed', changed: false });

        await expect(harness.action.execute({ pluginId: 'example.plugin' })).resolves.toEqual({
            status: 'completed',
            settings: { status: 'completed', changed: false },
            data: { status: 'completed', changed: false },
        });

        expect(harness.eraseSettings).toHaveBeenCalledTimes(2);
        expect(harness.eraseData).toHaveBeenCalledTimes(2);

        harness.eraseSettings.mockResolvedValueOnce({ status: 'completed', changed: false });
        harness.eraseData.mockResolvedValueOnce({ status: 'completed', changed: true });

        await expect(harness.action.execute({ pluginId: 'example.plugin' })).resolves.toEqual({
            status: 'completed',
            settings: { status: 'completed', changed: false },
            data: { status: 'completed', changed: true },
        });

        expect(harness.eraseSettings).toHaveBeenCalledTimes(3);
        expect(harness.eraseData).toHaveBeenCalledTimes(3);
    });

    it('does not reuse a partial invocation result for a later invocation', async () => {
        const harness = createHarness({ data: { status: 'pending', reason: 'unavailable' } });

        await expect(harness.action.execute({ pluginId: 'example.plugin' })).resolves.toEqual({
            status: 'partial',
            settings: { status: 'completed', changed: true },
            data: { status: 'pending', reason: 'unavailable' },
        });
        harness.eraseSettings.mockResolvedValueOnce({ status: 'completed', changed: false });
        harness.eraseData.mockResolvedValueOnce({ status: 'completed', changed: true });

        await expect(harness.action.execute({ pluginId: 'example.plugin' })).resolves.toEqual({
            status: 'completed',
            settings: { status: 'completed', changed: false },
            data: { status: 'completed', changed: true },
        });

        expect(harness.eraseSettings).toHaveBeenCalledTimes(2);
        expect(harness.eraseData).toHaveBeenCalledTimes(2);
    });

    it('reports transition cleanup as partial and advances it only on an explicit retry', async () => {
        const harness = createHarness({
            data: { status: 'pending', reason: 'transition-cleanup' },
        });

        await expect(harness.action.execute({ pluginId: 'example.plugin' })).resolves.toEqual({
            status: 'partial',
            settings: { status: 'completed', changed: true },
            data: { status: 'pending', reason: 'transition-cleanup' },
        });

        harness.eraseSettings.mockResolvedValueOnce({ status: 'completed', changed: false });
        harness.eraseData.mockResolvedValueOnce({ status: 'completed', changed: true });

        await expect(harness.action.execute({ pluginId: 'example.plugin' })).resolves.toEqual({
            status: 'completed',
            settings: { status: 'completed', changed: false },
            data: { status: 'completed', changed: true },
        });

        expect(harness.eraseSettings).toHaveBeenCalledTimes(2);
        expect(harness.eraseData).toHaveBeenCalledTimes(2);
    });

    it('reports unavailable and failed arms as partial, then revisits both owners on retry', async () => {
        const harness = createHarness({
            settings: { status: 'unavailable' },
            data: { status: 'failed', reason: 'account-not-found' },
        });

        await expect(harness.action.execute({ pluginId: 'example.orphaned-plugin' })).resolves.toEqual({
            status: 'partial',
            settings: { status: 'pending', reason: 'unavailable' },
            data: { status: 'failed', reason: 'account-not-found' },
        });

        harness.eraseSettings.mockResolvedValueOnce({ status: 'completed', changed: false });
        harness.eraseData.mockResolvedValueOnce({ status: 'completed', changed: true });

        await expect(harness.action.execute({ pluginId: 'example.orphaned-plugin' })).resolves.toEqual({
            status: 'completed',
            settings: { status: 'completed', changed: false },
            data: { status: 'completed', changed: true },
        });

        expect(harness.eraseSettings).toHaveBeenCalledTimes(2);
        expect(harness.eraseData).toHaveBeenCalledTimes(2);
    });

    it('accepts an orphaned plugin id without consulting an installed-plugin catalog', async () => {
        const harness = createHarness();

        await expect(harness.action.execute({ pluginId: 'example.orphaned-plugin' })).resolves.toMatchObject({
            status: 'completed',
        });

        expect(harness.eraseSettings).toHaveBeenCalledWith({
            pluginId: 'example.orphaned-plugin',
            target: { kind: 'account', serverIdentityId: 'server-identity-a' },
        });
        expect(harness.eraseData).toHaveBeenCalledWith(
            { pluginId: 'example.orphaned-plugin' },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
    });

    it('captures the replacement Account lifetime when retrying after retirement', async () => {
        const accountA = createLifetime({ serverId: 'server-a', accountId: 'account-a' });
        const harness = createHarness({
            lifetime: accountA,
            data: { status: 'pending', reason: 'unavailable' },
        });

        await expect(harness.action.execute({ pluginId: 'example.plugin' })).resolves.toMatchObject({
            status: 'partial',
            settings: { status: 'completed', changed: true },
        });
        const accountB = createLifetime({ serverId: 'server-b', accountId: 'account-b' });
        harness.captureActiveAccountScopeLifetime.mockReturnValue(accountB);
        harness.eraseSettings.mockResolvedValueOnce({ status: 'completed', changed: false });
        harness.eraseData.mockResolvedValueOnce({ status: 'completed', changed: true });
        accountA.retire();

        await expect(harness.action.execute({ pluginId: 'example.plugin' })).resolves.toEqual({
            status: 'completed',
            settings: { status: 'completed', changed: false },
            data: { status: 'completed', changed: true },
        });

        expect(harness.eraseSettings).toHaveBeenCalledTimes(2);
        expect(harness.eraseData).toHaveBeenCalledTimes(2);
    });
});
