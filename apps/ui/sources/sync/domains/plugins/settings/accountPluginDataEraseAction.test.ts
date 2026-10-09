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





    it('accepts an orphaned plugin id without consulting an installed-plugin catalog', async () => {
        const harness = createHarness();

        await expect(harness.action.execute({ pluginId: 'example.orphaned-plugin' })).resolves.toMatchObject({
            status: 'completed',
        });

        expect(harness.eraseSettings).toHaveBeenCalledWith({
            pluginId: 'example.orphaned-plugin',
            target: { kind: 'account', serverIdentityId: 'server-identity-a' },
            signal: expect.any(AbortSignal),
        });
        expect(harness.eraseData).toHaveBeenCalledWith(
            { pluginId: 'example.orphaned-plugin' },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
    });


});
