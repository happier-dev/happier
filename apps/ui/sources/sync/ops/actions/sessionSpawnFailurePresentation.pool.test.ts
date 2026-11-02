import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { Modal } from '@/modal/ModalManager';
import { joinList } from '@/utils/text/joinList';
import type { ModalConfig } from '@/modal/types';
import { resolveSessionSpawnNewResultFailureMessage, resolveSessionSpawnNewConnectedAccountFailure, presentSessionSpawnNewConnectedAccountFailure } from './sessionSpawnFailurePresentation';

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
    it('presents recovery actions with the failed service and the member that needs sign-in', () => {
        const recover = vi.fn();
        const shown: ModalConfig[] = [];
        const unregister = Modal.registerProvider({
            showModal: config => { shown.push({ ...config, id: 'pool-failure' } as ModalConfig); return 'pool-failure'; },
            hideModal: () => {},
            hideAllModals: () => {},
            updateCustomModalProps: () => {},
        });
        try {
            expect(presentSessionSpawnNewConnectedAccountFailure(failure, () => 'Codex', recover, Modal.alert)).toBe(true);
        } finally {
            unregister();
        }
        expect(shown).toEqual([expect.objectContaining({
            type: 'alert',
            title: resolveSessionSpawnNewConnectedAccountFailure(failure, 'Codex')?.title,
            message: t('connectedServicesPool.startUnavailableBody', { counts: resolveSessionSpawnNewConnectedAccountFailure(failure, 'Codex')?.reasons ?? '' }),
        })]);
        const modal = shown[0];
        const buttons = modal?.type === 'alert' ? modal.buttons : undefined;
        const signIn = buttons?.find(button => button.text === t('connectionStatus.summary.signInAgain'));
        const select = buttons?.find(button => button.text === t('connectedServicesPool.useAnotherAccount'));
        expect(signIn).toBeDefined();
        expect(select).toBeDefined();
        signIn?.onPress?.();
        select?.onPress?.();
        expect(recover.mock.calls).toEqual([
            [{ kind: 'reconnect', serviceId: 'happier.agent.codex/openai-codex', profileId: 'auth-1' }],
            [{ kind: 'select', serviceId: 'happier.agent.codex/openai-codex' }],
        ]);
    });
    it('titles the alert with the cause, keeps the counts in the body and puts Cancel under the recoveries', async () => {
        await preloadTranslations('en');
        const shown: ModalConfig[] = [];
        const unregister = Modal.registerProvider({
            showModal: config => { shown.push({ ...config, id: 'pool-failure' } as ModalConfig); return 'pool-failure'; },
            hideModal: () => {},
            hideAllModals: () => {},
            updateCustomModalProps: () => {},
        });
        try {
            presentSessionSpawnNewConnectedAccountFailure(failure, () => 'ChatGPT', () => {}, Modal.alert,
                (serviceId, profileId) => serviceId === 'happier.agent.codex/openai-codex' && profileId === 'auth-1' ? 'Leeroy' : null);
        } finally {
            unregister();
        }
        const modal = shown[0];
        expect(modal?.type).toBe('alert');
        if (modal?.type !== 'alert') return;
        expect(modal.title).toBe(t('connectedServicesPool.startUnavailable', { service: 'ChatGPT', reasons: '' }));
        expect(modal.title).not.toBe(t('common.error'));
        // The counts as one sentence, then the kept draft.
        expect(modal.message).toBe(t('connectedServicesPool.startUnavailableBody', { counts: joinList([
            t('connectedServicesPool.startUnavailableUsedUp', { count: 2 }),
            t('connectedServicesPool.startUnavailableSignIn', { count: 3 }),
        ], 'en') }));
        expect(modal.buttons?.map(button => button.style ?? 'default')).toEqual(['default', 'default', 'cancel']);
        // The sign-in choice names the account it reconnects.
        expect(modal.buttons?.[0]?.text).toBe(t('connectedServicesPool.signInAccount', { account: 'Leeroy' }));
    });
});
