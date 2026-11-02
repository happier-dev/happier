import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { resolveSessionSpawnNewResultFailureMessage, resolveSessionSpawnNewConnectedAccountFailure } from './sessionSpawnFailurePresentation';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const failure = {
    type: 'error', code: 'spawn_failed', retryable: false,
    launchError: { kind: 'launch_error', code: 'no_eligible_member', message: 'No eligible member', connectedAccountPool: {
        serviceId: 'happier.agent.codex/openai-codex', excluded: [
            { profileId: 'quota-1', reason: 'quota_exhausted' }, { profileId: 'quota-2', reason: 'quota_exhausted' },
            { profileId: 'auth-1', reason: 'auth_invalid' }, { profileId: 'auth-2', reason: 'auth_invalid' }, { profileId: 'auth-3', reason: 'auth_invalid' },
        ],
    } },
} satisfies SessionSpawnNewResultV1;

afterEach(() => setPreferredLanguageFromSettings('en'));
describe('connected-account pool start failure presentation', () => {
    it('retains the pool cause and groups the real exclusions without displaying private member ids', async () => {
        await preloadTranslations('en');
        const message = resolveSessionSpawnNewResultFailureMessage(failure);
        // The counts read as a sentence ("2 are used up and 3 need you to sign in again").
        expect(message).toContain(t('connectedServicesPool.startUnavailableSignIn', { count: 3 }));
        expect(message).toContain(t('connectedServicesPool.startUnavailableUsedUp', { count: 2 }));
        expect(message).not.toContain('×');
        expect(message).not.toContain('spawn_failed');
        expect(message).not.toContain('auth-1');
        const presentation = resolveSessionSpawnNewConnectedAccountFailure(failure, 'Codex');
        expect(presentation?.message).toContain('Codex');
        expect(presentation?.actions).toEqual([
            { kind: 'reconnect', serviceId: 'happier.agent.codex/openai-codex', profileId: 'auth-1' },
            { kind: 'select', serviceId: 'happier.agent.codex/openai-codex' },
        ]);
    });
    it('offers account selection without inventing sign-in for quota-only or empty exclusions', () => {
        for (const excluded of [failure.launchError.connectedAccountPool.excluded.slice(0, 2), []]) {
            const result = { ...failure, launchError: { ...failure.launchError,
                connectedAccountPool: { ...failure.launchError.connectedAccountPool, excluded } } };
            expect(resolveSessionSpawnNewConnectedAccountFailure(result, 'Codex')?.actions).toEqual([
                { kind: 'select', serviceId: 'happier.agent.codex/openai-codex' },
            ]);
        }
        expect(resolveSessionSpawnNewConnectedAccountFailure({ type: 'error', code: 'spawn_failed', retryable: true }, 'Codex')).toBeNull();
    });
});
