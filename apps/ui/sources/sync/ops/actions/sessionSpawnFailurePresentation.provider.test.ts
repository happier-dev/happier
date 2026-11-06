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
