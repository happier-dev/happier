import { describe, expect, it } from 'vitest';
import { SessionTeamCredentialBindingRejectionV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingV1';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { normalizeSpawnSessionErrorDetail } from '@happier-dev/protocol/spawnSession';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';

installReactNativeWebMock();
const {
  SUPPORTED_LANGUAGE_CODES,
  preloadTranslations,
  setPreferredLanguageFromSettings,
  t,
} = await import('@/text');
const {
  resolveSessionSpawnErrorDetailFailureMessage,
  resolveSessionSpawnNewOperationFailureMessage,
  resolveSessionSpawnNewResultFailureMessage,
} = await import('./sessionSpawnFailurePresentation');

const REASONS = SessionTeamCredentialBindingRejectionV1Schema.options;
const CODE = 'session_team_credential_binding_rejected';

function refusal(reason: (typeof REASONS)[number]) {
  const parsed = SessionSpawnNewResultV1Schema.parse({
    type: 'error',
    code: CODE,
    reason,
    retryable: false,
  });
  if (parsed.type !== 'error') throw new Error('Expected a creation refusal');
  return parsed;
}

describe('a refused Team credential binding, said once for New Session and Fork', () => {
  it('uses the Session access sign-in recovery for a refused restricted Team attachment', async () => {
    await preloadTranslations('en');
    setPreferredLanguageFromSettings('en');
    const parsed = SessionSpawnNewResultV1Schema.parse({
      type: 'error',
      code: 'session_access_authentication_required',
      retryable: false,
    });
    if (parsed.type !== 'error') throw new Error('Expected a creation refusal');
    expect(resolveSessionSpawnNewResultFailureMessage(parsed)).toBe(t('session.access.authenticationRequired'));
    expect(resolveSessionSpawnErrorDetailFailureMessage(normalizeSpawnSessionErrorDetail({
      kind: 'session_creation_access_refused',
      code: parsed.code,
    }))).toBe(t('session.access.authenticationRequired'));
  });

  it('uses the same sign-in recovery when creation settles as a retained operation', async () => {
    await preloadTranslations('en');
    setPreferredLanguageFromSettings('en');
    const errorCode = 'session_access_authentication_required';
    expect(resolveSessionSpawnNewOperationFailureMessage({ errorCode, error: errorCode }))
      .toBe(t('session.access.authenticationRequired'));
  });

  it('gives every closed reason its own sentence in every locale, never a code or a key', async () => {
    for (const language of SUPPORTED_LANGUAGE_CODES) {
      await preloadTranslations(language as never);
      setPreferredLanguageFromSettings(language);
      for (const reason of REASONS) {
        const message = resolveSessionSpawnNewResultFailureMessage(
          refusal(reason),
        );
        expect(message, `${language}:${reason}`).toBeTruthy();
        expect(message, `${language}:${reason}`).not.toContain(CODE);
        expect(message, `${language}:${reason}`).not.toContain(reason);
        expect(message, `${language}:${reason}`).not.toContain(
          'session.startFailure',
        );
        expect(message, `${language}:${reason}`).not.toBe(
          t('newSession.failedToStart'),
        );
      }
    }
  });

  it('tells a person refused on an older shared-model revision to choose it again', async () => {
    await preloadTranslations('en');
    setPreferredLanguageFromSettings('en');
    expect(
      resolveSessionSpawnNewResultFailureMessage(refusal('resource_changed')),
    ).toBe(t('session.startFailure.teamCredentialBinding.resource_changed'));
  });

  it('reads a Fork refusal detail through the same sentence as the refused start', async () => {
    await preloadTranslations('en');
    setPreferredLanguageFromSettings('en');
    const detail = normalizeSpawnSessionErrorDetail({
      kind: 'session_creation_team_credential_refused',
      code: CODE,
      reason: 'team_context_required',
    });
    expect(resolveSessionSpawnErrorDetailFailureMessage(detail)).toBe(
      resolveSessionSpawnNewResultFailureMessage(
        refusal('team_context_required'),
      ),
    );
    expect(resolveSessionSpawnErrorDetailFailureMessage(undefined)).toBeNull();
  });
});
