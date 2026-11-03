import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectedServiceCredentialRefreshFailureKindV1 } from '@happier-dev/protocol/connect/connected-service-schemas';

import { preloadTranslations, setPreferredLanguageFromSettings, t, type SupportedLanguage } from '@/text';
import { resolveConnectedAccountCredentialStatusLabel } from './connectedAccountCredentialStatusLabel';

beforeAll(async () => {
    await preloadTranslations('en');
    setPreferredLanguageFromSettings('en');
});
afterEach(() => setPreferredLanguageFromSettings('en'));

describe('connected account credential status label', () => {
    it.each([
        ['invalid_grant', 'sign-in no longer accepted'],
        ['provider_401', 'sign-in no longer accepted'],
        ['provider_403', 'sign-in no longer accepted'],
        ['invalid_client', 'app access was removed'],
        ['missing_refresh_token', "can't refresh by itself"],
    ] satisfies [ConnectedServiceCredentialRefreshFailureKindV1, string][])(
        'explains signed-out %s without guessing expiry, revocation or plan',
        (reason, explanation) => {
            expect(resolveConnectedAccountCredentialStatusLabel('needs_reauth', reason))
                .toBe(`Signed out · ${explanation}`);
        },
    );

    it.each([
        undefined, 'network_error', 'malformed_response', 'missing_access_token', 'unknown',
    ] satisfies (ConnectedServiceCredentialRefreshFailureKindV1 | undefined)[])(
        'keeps a bare signed-out label for %s',
        (reason) => expect(resolveConnectedAccountCredentialStatusLabel('needs_reauth', reason)).toBe('Signed out'),
    );

    it('ignores retained failure evidence after recovery and during refresh', () => {
        expect(resolveConnectedAccountCredentialStatusLabel('connected', 'invalid_grant'))
            .toBe(t('connectedServices.detail.profiles.connected'));
        expect(resolveConnectedAccountCredentialStatusLabel('refreshing', 'invalid_grant'))
            .toBe(t('connectedServices.detail.profiles.refreshing'));
        expect(resolveConnectedAccountCredentialStatusLabel('refresh_failed_retryable', 'invalid_grant'))
            .toBe(t('connectedServices.detail.profiles.refreshFailedRetryable'));
    });

    it.each([
        ['en', "Signed out · can't refresh by itself"],
        ['ca', 'Sessió tancada · no es pot renovar automàticament'],
        ['de', 'Abgemeldet · kann sich nicht selbst erneuern'],
        ['es', 'Sesión cerrada · no puede renovarse automáticamente'],
        ['fr', 'Déconnecté · ne peut pas se renouveler automatiquement'],
        ['it', 'Disconnesso · non può rinnovarsi automaticamente'],
        ['ja', 'サインアウト済み · 自動では更新できません'],
        ['pl', 'Wylogowano · nie może odświeżać się samodzielnie'],
        ['pt', 'Sessão terminada · não se pode renovar automaticamente'],
        ['ru', 'Выполнен выход · не может обновляться самостоятельно'],
        ['zh-Hans', '已退出登录 · 无法自动刷新'],
        ['zh-Hant', '已登出 · 無法自動重新整理'],
    ] satisfies [SupportedLanguage, string][])('uses the active %s locale for the whole status', async (language, label) => {
        await preloadTranslations(language);
        setPreferredLanguageFromSettings(language);
        expect(resolveConnectedAccountCredentialStatusLabel('needs_reauth', 'missing_refresh_token')).toBe(label);
    });
});
