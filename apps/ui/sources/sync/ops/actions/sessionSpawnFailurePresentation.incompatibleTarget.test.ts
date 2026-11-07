import { describe, expect, it } from 'vitest';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';

installReactNativeWebMock();
const { preloadTranslations, t } = await import('@/text');
const { resolveSessionSpawnNewResultFailureMessage } = await import('./sessionSpawnFailurePresentation');

describe('an incompatible start target', () => {
    it('tells the person what to do on that Machine instead of a bare incompatible_target code', async () => {
        await preloadTranslations('en');
        const older = SessionSpawnNewResultV1Schema.parse({ type: 'error', code: 'incompatible_target', retryable: false,
            incompatibleTarget: { reason: 'session_spawn_protocol_unavailable' } });
        expect(resolveSessionSpawnNewResultFailureMessage(older)).toBe(t('newSession.actionMethodUnavailable'));
        const unreachable = SessionSpawnNewResultV1Schema.parse({ type: 'error', code: 'incompatible_target', retryable: false,
            incompatibleTarget: { reason: 'daemon_rpc_unavailable' } });
        expect(resolveSessionSpawnNewResultFailureMessage(unreachable)).toBe(t('newSession.daemonRpcUnavailableBody'));
    });
});
