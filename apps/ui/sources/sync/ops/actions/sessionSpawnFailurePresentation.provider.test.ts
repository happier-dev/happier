import { describe, expect, it } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { presentProviderError } from '@/providers/connection/errorPresentation';

installReactNativeWebMock();
const { preloadTranslations, t } = await import('@/text');
const { resolveSessionSpawnNewResultFailureMessage } = await import('./sessionSpawnFailurePresentation');
const { createPresentedFirstTurnSettlement } = await import('@/components/sessions/new/modules/presentedFirstTurnSettlement');

describe('Provider causes in Session-start failures', () => {
    it('presents the refused launch Profile and its typed reason with the Action request', async () => {
        await preloadTranslations('en');
        const profileId = 'foreign-default-profile';
        const result = SessionSpawnNewResultV1Schema.parse({ type: 'error', code: 'spawn_failed', retryable: false,
            launchError: { kind: 'launch_error', code: 'profile_launch_unavailable',
                message: `Launch profile '${profileId}' is not present in canonical account settings`,
                profileRefusal: { profileId, reason: 'profile_overlay_mismatch' },
            },
        });
        if (result.type !== 'error') throw new Error('Expected Profile refusal');
        const message = resolveSessionSpawnNewResultFailureMessage(result, 'profile-launch-request');
        expect(message).toContain(profileId);
        expect(message).toContain('profile_overlay_mismatch');
        expect(message).toContain('profile-launch-request');
        expect(message).not.toContain('invalid_input');
    });

    it.each(['connected_account_purpose_catalog_unavailable', 'connected_services_default_settings_invalid'] as const)(
        'presents the default-account refusal %s with its request identity', async code => {
            await preloadTranslations('en');
            const result = SessionSpawnNewResultV1Schema.parse({ type: 'error', code: 'spawn_failed', retryable: true,
                launchError: { kind: 'launch_error', code, message: code },
            });
            if (result.type !== 'error') throw new Error('Expected default-account refusal');
            const requestId = 'spawn-default-request';
            const message = resolveSessionSpawnNewResultFailureMessage(result, requestId);
            expect(message).toContain(code);
            expect(message).toContain(t('session.startFailure.requestId', { id: requestId }));
            expect(message).not.toContain('spawn_failed');
        },
    );

    it('names a missing Session folder instead of the generic spawn failure', async () => {
        await preloadTranslations('en');
        const result = SessionSpawnNewResultV1Schema.parse({ type: 'error', code: 'spawn_failed', retryable: true,
            launchError: { kind: 'launch_error', code: 'SESSION_DIRECTORY_MISSING',
                message: 'The Session folder does not exist on the Machine. Choose another folder.' },
        });
        if (result.type !== 'error') throw new Error('Expected a missing-folder refusal');
        const message = resolveSessionSpawnNewResultFailureMessage(result);
        expect(message).toContain(t('errors.workspaceFolderMissing'));
        expect(message).not.toContain('spawn_failed');
    });

    it.each(['provider_authorization_changed', 'provider_secret_missing'] as const)(
        'retains %s through the strict spawn result and canonical Provider presenter', async code => {
            await preloadTranslations('en');
            const providerError = createProviderErrorV1(code, { connectionId: 'pc_gateway', machineId: 'machine-a' });
            const result = SessionSpawnNewResultV1Schema.parse({
                type: 'error', code: 'spawn_failed', retryable: providerError.retryable, providerError,
            });
            if (result.type !== 'error') throw new Error('Expected a spawn refusal');
            const presentation = presentProviderError(providerError);
            const message = resolveSessionSpawnNewResultFailureMessage(result);
            expect(message).toContain(t(presentation.titleKey));
            expect(message).toContain(t(presentation.descriptionKey));
            expect(message).not.toContain('spawn_failed');
            const settlements: unknown[] = [];
            const firstTurn = createPresentedFirstTurnSettlement({
                draftId: 'draft-a', readCanonicalOperation: () => null,
                write: (_presented, settlement) => { settlements.push(settlement); },
            });
            firstTurn.present({ sessionId: 'session-a', firstTurnLocalId: 'first-turn-a' });
            firstTurn.observe({ ok: true, result });
            firstTurn.settle({ final: false });
            expect(settlements).toEqual([{ state: 'failed', message, draftId: 'draft-a' }]);
        },
    );
});
