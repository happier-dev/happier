import { t } from '@/text';

/**
 * The one status vocabulary for "is this sign-in connection working", for a Home's company sign-in
 * providers and a Team's sign-in connections alike (DR-11).
 *
 * The Home and the Team each own how their record reaches one of these states; neither owns the
 * words. A screen never maps a status to text itself, so the same state cannot read "Active" on one
 * page and "Connected" on another.
 */
export type SignInConnectionStatus =
  | 'unavailable'
  | 'prohibited'
  | 'not_configured'
  | 'setting_up'
  | 'test_required'
  | 'retest_required'
  | 'tested'
  | 'active'
  | 'needs_attention'
  | 'disabled';

/** Healthy and deliberately-off states stay quiet; only a state that needs someone speaks. */
export type SignInConnectionStatusTone = 'quiet' | 'attention' | 'trouble';

/** The only place a sign-in connection status becomes words. */
export function signInConnectionStatusLabel(
  status: SignInConnectionStatus,
): string {
  switch (status) {
    case 'unavailable':
      return t('teams.authentication.status.unavailable');
    case 'prohibited':
      return t('teams.authentication.status.prohibited');
    case 'not_configured':
      return t('teams.authentication.status.notConfigured');
    case 'setting_up':
      return t('teams.authentication.status.settingUp');
    case 'test_required':
      return t('identityAdministration.needsTest');
    case 'retest_required':
      return t('identityAdministration.staleTest');
    case 'tested':
      return t('identityAdministration.tested');
    case 'active':
      return t('identityAdministration.active');
    case 'needs_attention':
      return t('teams.authentication.status.needsAttention');
    case 'disabled':
      return t('identityAdministration.disabled');
  }
}

export function signInConnectionStatusTone(
  status: SignInConnectionStatus,
): SignInConnectionStatusTone {
  switch (status) {
    case 'needs_attention':
    case 'unavailable':
      return 'trouble';
    case 'setting_up':
    case 'not_configured':
    case 'test_required':
    case 'retest_required':
      return 'attention';
    case 'prohibited':
    case 'tested':
    case 'active':
    case 'disabled':
      return 'quiet';
  }
}

/**
 * The status of a record whose health is its switch and its last sign-in test (a Home provider).
 * Off wins over everything; a record that cannot be tested is simply active; a test taken before
 * the configuration last changed asks for another.
 */
export function resolveTestedSignInConnectionStatus(
  record: Readonly<{
    enabled: boolean;
    /** False for a kind with no sign-in test of its own (a GitHub App identity). */
    testable: boolean;
    lastSuccessfulTest: Readonly<{ current: boolean }> | null | undefined;
  }>,
): SignInConnectionStatus {
  if (!record.enabled) return 'disabled';
  if (!record.testable) return 'active';
  if (!record.lastSuccessfulTest) return 'test_required';
  return record.lastSuccessfulTest.current ? 'tested' : 'retest_required';
}
