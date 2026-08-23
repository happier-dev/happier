import { describe, expect, it, vi } from 'vitest';

import { completeApiTokenSettingsSignOutEverywhere } from './apiTokenSettingsSignOutLifecycle';
import { apiTokenSettingsTranslations } from '@/text/translations/apiTokenSettingsTranslations';

describe('completeApiTokenSettingsSignOutEverywhere', () => {
    it('runs the canonical local credential lifecycle exactly once after the Account Action succeeds', async () => {
        const guardAuthorized = vi.fn();
        const signOutEverywhere = vi.fn(async () => true);
        const replace = vi.fn();
        const deleteLocalCredentials = vi.fn();
        const logout = vi.fn(async (options?: Readonly<{ beforeMutation?: () => void | Promise<void> }>) => {
            guardAuthorized();
            await options?.beforeMutation?.();
            deleteLocalCredentials();
            return { kind: 'completed' as const };
        });

        await expect(completeApiTokenSettingsSignOutEverywhere({
            signOutEverywhere,
            logout,
            replace,
        })).resolves.toBe(true);

        expect(signOutEverywhere).toHaveBeenCalledTimes(1);
        expect(logout).toHaveBeenCalledTimes(1);
        expect(replace).toHaveBeenCalledExactlyOnceWith('/');
        expect(guardAuthorized.mock.invocationCallOrder[0]).toBeLessThan(signOutEverywhere.mock.invocationCallOrder[0]!);
        expect(signOutEverywhere.mock.invocationCallOrder[0]).toBeLessThan(replace.mock.invocationCallOrder[0]!);
        expect(replace.mock.invocationCallOrder[0]).toBeLessThan(deleteLocalCredentials.mock.invocationCallOrder[0]!);
    });

    it('does not mutate local credentials or navigation when the Account Action fails', async () => {
        const deleteLocalCredentials = vi.fn();
        const logout = vi.fn(async (options?: Readonly<{ beforeMutation?: () => void | Promise<void> }>) => {
            await options?.beforeMutation?.();
            deleteLocalCredentials();
            return { kind: 'completed' as const };
        });
        const replace = vi.fn();

        await expect(completeApiTokenSettingsSignOutEverywhere({
            signOutEverywhere: async () => false,
            logout,
            replace,
        })).resolves.toBe(false);

        expect(logout).toHaveBeenCalledTimes(1);
        expect(deleteLocalCredentials).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
    });

    it('states the independent PAT and bounded local-daemon revocation contracts explicitly', () => {
        const copy = apiTokenSettingsTranslations.en.settingsApiTokens;
        expect(copy.signOutEverywhere.body).toContain('PATs remain active');
        expect(copy.revoke.body).toContain('up to one minute');
        expect(copy.revokeAll.body).toContain('up to one minute');
    });

    it('states the API-token authority and one-time secret guidance truthfully', () => {
        const copy = apiTokenSettingsTranslations.en.settingsApiTokens;
        expect(copy.emptyBody).toContain('Tokens let scripts and tools act as you.');
        expect(`${copy.create.actionSettingsPrefix} ${copy.create.actionSettingsLink}`)
            .toBe('This token can perform any operation enabled for External API & SDK in your Action settings.');
        expect(copy.reveal.accessibilityAnnouncement).toBe('Copy your token now — it is shown once.');
    });
});
