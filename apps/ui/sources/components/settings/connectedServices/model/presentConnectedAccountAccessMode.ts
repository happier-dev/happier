import { t } from '@/text';
import { resolveConnectedAccountAccessMode } from './resolveConnectedAccountAccessMode';

/**
 * How an account reaches its vendor, as the account's record states it: a subscription signed in by a
 * person, or an API key (with the last characters of that key when the record holds them). The value
 * comes from the producing service; nothing here infers it from a sign-in method or a model name.
 */
export type ConnectedAccountAccessMode =
  | Readonly<{ kind: 'subscription' }>
  | Readonly<{ kind: 'apiKey'; keySuffix: string | null }>;

/** A key an account holds besides its sign-in, created when it connected (a Muse device sign-in mints one). */
export type ConnectedAccountIncludedApiKey = Readonly<{
  keySuffix: string | null;
}>;

/**
 * The one place an account's mode is said (lab `muse-accounts` A1): line 2 of its rail row and the
 * detail header's meta line. A subscription says its plan when the vendor reports one, otherwise
 * "Subscription"; a key says "API key · ends 7Qa2".
 */
export function presentConnectedAccountAccessMode(
  mode: ConnectedAccountAccessMode,
  planLabel: string | null | undefined,
): string {
  if (mode.kind === 'subscription')
    return (
      planLabel?.trim() || t('connectedServicesSettings.accessSubscription')
    );
  return [
    t('connectedServicesSettings.accessApiKey'),
    mode.keySuffix
      ? t('connectedServicesSettings.accessKeyEnds', { suffix: mode.keySuffix })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Keep an observed plan for unknown accounts; only an explicit key mode suppresses it. */
export function presentConnectedAccountAccessModeForAccount(
  account: Parameters<typeof resolveConnectedAccountAccessMode>[0],
  planLabel: string | null | undefined,
  subscription?: Parameters<typeof resolveConnectedAccountAccessMode>[1],
): string | null {
  const mode = resolveConnectedAccountAccessMode(account, subscription);
  return mode ? presentConnectedAccountAccessMode(mode, planLabel) : planLabel?.trim() || null;
}

/** "Created when you connected · ends 4f9c": the included key's fact line, never its value. */
export function describeConnectedAccountIncludedApiKey(
  key: ConnectedAccountIncludedApiKey,
): string {
  return [
    t('connectedServicesSettings.detailIncludesApiKeyCreated'),
    key.keySuffix
      ? t('connectedServicesSettings.accessKeyEnds', { suffix: key.keySuffix })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
