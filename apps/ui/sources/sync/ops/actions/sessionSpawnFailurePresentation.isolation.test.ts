import { describe, expect, it, vi } from 'vitest';
import type { SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { preloadTranslations, t } from '@/text';
import { resolveSessionSpawnNewResultFailureMessage } from './sessionSpawnFailurePresentation';
import { presentSessionRuntimeIssue } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

describe('isolation refusal on a member’s session start (UI-LOGIC-R8, B-LAUNCH2)', () => {
  it('presents a typed Machine admission refusal through the existing launch failure', async () => {
    await preloadTranslations('en');
    const result = {
      type: 'error', code: 'spawn_failed', retryable: true,
      launchError: { kind: 'launch_error', code: 'machine_target_not_current', message: 'root_target_mismatch' },
    } satisfies SessionSpawnNewResultV1;
    const message = resolveSessionSpawnNewResultFailureMessage(result);
    expect(message).toContain(t('session.startFailure.cause.admission_unavailable'));
    expect(message).toContain(result.launchError.code);
    expect(message).not.toContain(t('newSession.failedToStart'));
  });
  for (const code of [
    'agent_isolation_unavailable',
    'filesystem_identity_custody_unavailable',
    'session_launch_material_missing',
    'managed_binary_missing',
    'session_mcp_context_missing',
  ] as const) {
    it(`says the real reason for ${code}, not the generic start failure`, async () => {
      await preloadTranslations('en');
      const result = {
        type: 'error',
        code: 'spawn_failed',
        retryable: false,
        launchError: { kind: 'launch_error', code, message: code },
      } satisfies SessionSpawnNewResultV1;
      const message = resolveSessionSpawnNewResultFailureMessage(result);
      expect(message).toContain(t('errors.agentIsolationUnavailable'));
      expect(message).toContain(code);
      expect(message).not.toContain(t('newSession.failedToStart'));
      const banner = presentSessionRuntimeIssue({ v: 1, scope: 'primary_session', status: 'failed', code,
        source: 'agent_session_error', occurredAt: 1, failureCause: { phase: 'client_start', failureReason: 'unknown', code } });
      expect(banner.message).toContain(t('errors.agentIsolationUnavailable'));
      expect(banner.details).toContain(code);
    });
  }
});
