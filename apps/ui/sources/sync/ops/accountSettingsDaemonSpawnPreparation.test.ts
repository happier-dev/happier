import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    prepareAccountSettingsForDaemonSpawnIfNeeded,
    registerAccountSettingsDaemonSpawnPreparation,
} from './accountSettingsDaemonSpawnPreparation';
import { AccountSettingsScopeChangedDuringSpawnPreparationError } from '@/sync/engine/settings/accountSettingsSpawnPreparationError';

describe('account settings daemon spawn preparation registry', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        registerAccountSettingsDaemonSpawnPreparation(async () => ({}))();
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    it('returns no hint when no preparation provider is registered', async () => {
        await expect(prepareAccountSettingsForDaemonSpawnIfNeeded(undefined)).resolves.toEqual({});
    });

    it('uses the registered preparation provider when no valid hint exists', async () => {
        const prepare = vi.fn(async () => ({ accountSettingsVersionHint: 7 }));
        const unregister = registerAccountSettingsDaemonSpawnPreparation(prepare);

        await expect(prepareAccountSettingsForDaemonSpawnIfNeeded(undefined)).resolves.toEqual({
            accountSettingsVersionHint: 7,
        });
        expect(prepare).toHaveBeenCalledTimes(1);

        unregister();
    });

    it('returns no hint when the registered preparation provider fails', async () => {
        const prepare = vi.fn(async () => {
            throw new Error('settings sync unavailable');
        });
        const unregister = registerAccountSettingsDaemonSpawnPreparation(prepare);

        await expect(prepareAccountSettingsForDaemonSpawnIfNeeded(undefined)).resolves.toEqual({});
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to prepare account settings before daemon spawn'),
            expect.any(Error),
        );

        unregister();
    });

    it('propagates account settings scope changes during preparation', async () => {
        const prepare = vi.fn(async () => {
            throw new AccountSettingsScopeChangedDuringSpawnPreparationError();
        });
        const unregister = registerAccountSettingsDaemonSpawnPreparation(prepare);

        await expect(prepareAccountSettingsForDaemonSpawnIfNeeded(undefined)).rejects.toThrow(
            AccountSettingsScopeChangedDuringSpawnPreparationError,
        );
        expect(prepare).toHaveBeenCalledTimes(1);

        unregister();
    });

    it('propagates pending account settings flush failures instead of silently spawning stale settings', async () => {
        const pendingFlushError = Object.assign(
            new Error('Account settings changes could not be synced before spawning'),
            { code: 'ACCOUNT_SETTINGS_PENDING_FLUSH_FAILED_BEFORE_SPAWN' },
        );
        const prepare = vi.fn(async () => {
            throw pendingFlushError;
        });
        const unregister = registerAccountSettingsDaemonSpawnPreparation(prepare);

        await expect(prepareAccountSettingsForDaemonSpawnIfNeeded(undefined)).rejects.toMatchObject({
            code: 'ACCOUNT_SETTINGS_PENDING_FLUSH_FAILED_BEFORE_SPAWN',
        });
        expect(prepare).toHaveBeenCalledTimes(1);

        unregister();
    });

    it('does not override an explicit valid version hint', async () => {
        const prepare = vi.fn(async () => ({ accountSettingsVersionHint: 7 }));
        const unregister = registerAccountSettingsDaemonSpawnPreparation(prepare);

        await expect(prepareAccountSettingsForDaemonSpawnIfNeeded(4)).resolves.toEqual({});
        expect(prepare).not.toHaveBeenCalled();

        unregister();
    });

    it('keeps the latest registered provider until it is unregistered', async () => {
        const first = vi.fn(async () => ({ accountSettingsVersionHint: 1 }));
        const second = vi.fn(async () => ({ accountSettingsVersionHint: 2 }));
        const unregisterFirst = registerAccountSettingsDaemonSpawnPreparation(first);
        const unregisterSecond = registerAccountSettingsDaemonSpawnPreparation(second);

        unregisterFirst();

        await expect(prepareAccountSettingsForDaemonSpawnIfNeeded(null)).resolves.toEqual({
            accountSettingsVersionHint: 2,
        });
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);

        unregisterSecond();
    });
});
