import type { HomeRoleV1 } from '@happier-dev/protocol/home/governance';
import type { TeamIdentityEligibleProviderV1 } from '@happier-dev/protocol/teams';

import {
  homeAdministrationIdentityProviderPath,
  homeAdministrationReachPath,
  homeAdministrationSignInProvidersPath,
} from '@/components/settings/home/governance/homeAdministrationRoutes';
import { homeSignInPlatformHref } from '@/components/settings/home/signInProviders/homeSignInPlatforms';
import { HOME_SIGN_IN_PROVIDERS_SETTINGS } from '@/components/settings/home/signInProviders/homeSignInProvidersSettings';
import { buildSettingHref } from '@/components/settings/catalog/settingDeclarations';
import { t } from '@/text';

/**
 * Who can lift an unavailable sign-in choice, and where (DR-04, lab `tsAuth-M`/`tsAuth-H`).
 *
 * Every reason a Team cannot add a provider is a Home fact: the Home's WorkOS credentials, a Home
 * provider turned off, the Home's rules for what Teams may add, or the Home's public address. Only a
 * Home owner can change those (sign-in providers are owner-only, HCLOG-08), so an owner is led to the
 * exact row or page that fixes it, and everyone else is told whom to ask. The typed code comes from the
 * Team identity eligibility projection; nothing here decides availability.
 */
export type EligibleProviderRecovery =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'fix_on_home';
      destination: EligibleProviderFixDestination;
    }>
  | Readonly<{ kind: 'ask'; names: readonly string[] }>;

/**
 * Where on the Home a reason is fixed: the WorkOS credentials row, the switched-off provider's own
 * page, the Home's rules for what Teams may add, the page listing the providers, or Reach.
 */
export type EligibleProviderFixDestination =
  | 'workos_platform'
  | 'home_provider'
  | 'team_rules'
  | 'sign_in_providers'
  | 'reach';

type UnavailableCode = Extract<
  TeamIdentityEligibleProviderV1['availability'],
  { status: 'unavailable' }
>['code'];

function homeDestination(
  provider: TeamIdentityEligibleProviderV1,
  code: UnavailableCode | 'contact_home_admin',
): EligibleProviderFixDestination {
  switch (code) {
    case 'workos_platform_unavailable':
      return 'workos_platform';
    case 'provider_disabled':
      return provider.owner === 'home' && provider.providerId !== null
        ? 'home_provider'
        : 'sign_in_providers';
    case 'home_policy_prohibited':
    case 'home_policy_unavailable':
      return 'team_rules';
    case 'provider_setup_unavailable':
      return 'reach';
    case 'contact_home_admin':
      return 'sign_in_providers';
  }
}

export function resolveEligibleProviderRecovery(
  provider: TeamIdentityEligibleProviderV1,
  viewer: Readonly<{
    viewerHomeRole: HomeRoleV1 | null;
    administratorNames: readonly string[] | null;
  }>,
): EligibleProviderRecovery {
  const availability = provider.availability;
  const code =
    availability.status === 'unavailable'
      ? availability.code
      : availability.setupChoice.kind === 'contact_home_admin'
        ? ('contact_home_admin' as const)
        : null;
  if (code === null) return { kind: 'none' };
  if (viewer.viewerHomeRole === 'owner')
    return { kind: 'fix_on_home', destination: homeDestination(provider, code) };
  return { kind: 'ask', names: viewer.administratorNames ?? [] };
}

/** One sentence per typed reason, said in the Home's name rather than as a configuration fragment. */
export function eligibleProviderUnavailableReason(
  provider: TeamIdentityEligibleProviderV1,
  homeName: string,
  providerName: string,
): string | null {
  const availability = provider.availability;
  if (availability.status === 'available') {
    return availability.setupChoice.kind === 'contact_home_admin'
      ? t('teams.authentication.add.reason.contactHomeAdmin', {
          home: homeName,
        })
      : null;
  }
  switch (availability.code) {
    case 'workos_platform_unavailable':
      return t('teams.authentication.add.reason.workosPlatform', {
        home: homeName,
      });
    case 'provider_disabled':
      return t('teams.authentication.add.reason.providerDisabled', {
        home: homeName,
      });
    case 'home_policy_prohibited':
      return t('teams.authentication.add.reason.homeProhibited', {
        home: homeName,
        provider: providerName,
      });
    case 'home_policy_unavailable':
      return t('teams.authentication.add.reason.homeUnavailable', {
        home: homeName,
      });
    case 'provider_setup_unavailable':
      return t('teams.authentication.add.reason.publicAddress', {
        home: homeName,
      });
  }
}

/**
 * The address of the fix. Each destination's own owner supplies it — the platform row's link opens
 * that row on arrival — so this page never spells a console address itself.
 */
export function eligibleProviderFixHref(
  serverId: string,
  provider: TeamIdentityEligibleProviderV1,
  destination: EligibleProviderFixDestination,
): string {
  switch (destination) {
    case 'workos_platform':
      return homeSignInPlatformHref(serverId, 'workos');
    case 'home_provider':
      return provider.providerId !== null
        ? homeAdministrationIdentityProviderPath(serverId, provider.providerId)
        : homeAdministrationSignInProvidersPath(serverId);
    case 'team_rules':
      return buildSettingHref(
        homeAdministrationSignInProvidersPath(serverId),
        HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.allowedTeamProviderKinds,
      );
    case 'sign_in_providers':
      return homeAdministrationSignInProvidersPath(serverId);
    case 'reach':
      return homeAdministrationReachPath(serverId);
  }
}

/** The label of the link a Home owner follows to fix the reason. */
export function eligibleProviderFixLabel(
  destination: EligibleProviderFixDestination,
): string {
  switch (destination) {
    case 'home_provider':
      return t('teams.authentication.add.fixTurnOn');
    case 'workos_platform':
    case 'team_rules':
    case 'sign_in_providers':
      return t('teams.authentication.add.fixInSignInProviders');
    case 'reach':
      return t('teams.authentication.add.fixInReach');
  }
}
