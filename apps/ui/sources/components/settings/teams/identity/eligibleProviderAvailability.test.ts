import { describe, expect, it } from 'vitest';
import type { TeamIdentityEligibleProviderV1 } from '@happier-dev/protocol/teams';

import { homeSignInPlatformHref } from '@/components/settings/home/signInProviders/homeSignInPlatforms';
import {
  homeAdministrationIdentityProviderPath,
  homeAdministrationReachPath,
  homeAdministrationSignInProvidersPath,
} from '@/components/settings/home/governance/homeAdministrationRoutes';

import {
  eligibleProviderFixHref,
  resolveEligibleProviderRecovery,
} from './eligibleProviderAvailability';

function unavailable(
  code: Extract<
    TeamIdentityEligibleProviderV1['availability'],
    { status: 'unavailable' }
  >['code'],
  providerKind: TeamIdentityEligibleProviderV1['providerKind'] = 'workos_sso',
): TeamIdentityEligibleProviderV1 {
  return {
    v: 1,
    providerId: null,
    providerKind,
    owner: 'home',
    displayName: null,
    availability: { status: 'unavailable', code },
  };
}

describe('resolveEligibleProviderRecovery', () => {
  it('leads a Home owner to the console page that fixes each Home-owned reason', () => {
    const owner = {
      viewerHomeRole: 'owner' as const,
      administratorNames: ['Ana Silva'],
    };
    expect(
      resolveEligibleProviderRecovery(
        unavailable('workos_platform_unavailable'),
        owner,
      ),
    ).toEqual({ kind: 'fix_on_home', destination: 'workos_platform' });
    // A switched-off Home provider is fixed on that provider's own page; without a known provider
    // the page that lists them is the nearest truthful place.
    expect(
      resolveEligibleProviderRecovery(
        { ...unavailable('provider_disabled', 'oidc'), providerId: 'idp-1' },
        owner,
      ),
    ).toEqual({ kind: 'fix_on_home', destination: 'home_provider' });
    expect(
      resolveEligibleProviderRecovery(
        unavailable('provider_disabled', 'oidc'),
        owner,
      ),
    ).toEqual({ kind: 'fix_on_home', destination: 'sign_in_providers' });
    expect(
      resolveEligibleProviderRecovery(
        unavailable('home_policy_prohibited', 'github_app_identity'),
        owner,
      ),
    ).toEqual({ kind: 'fix_on_home', destination: 'team_rules' });
    expect(
      resolveEligibleProviderRecovery(
        unavailable('home_policy_unavailable', 'oidc'),
        owner,
      ),
    ).toEqual({ kind: 'fix_on_home', destination: 'team_rules' });
    expect(
      resolveEligibleProviderRecovery(
        unavailable('provider_setup_unavailable', 'oidc'),
        owner,
      ),
    ).toEqual({ kind: 'fix_on_home', destination: 'reach' });
  });

  it('names who can fix it for a Team owner who does not own the Home', () => {
    expect(
      resolveEligibleProviderRecovery(
        unavailable('workos_platform_unavailable'),
        {
          viewerHomeRole: 'member',
          administratorNames: ['Ana Silva', 'Leeroy Brun'],
        },
      ),
    ).toEqual({ kind: 'ask', names: ['Ana Silva', 'Leeroy Brun'] });
    // A Home admin cannot change sign-in providers either (owners only), so they are asked too.
    expect(
      resolveEligibleProviderRecovery(
        unavailable('provider_disabled', 'oidc'),
        {
          viewerHomeRole: 'admin',
          administratorNames: ['Ana Silva'],
        },
      ),
    ).toEqual({ kind: 'ask', names: ['Ana Silva'] });
  });

  it('still says a Home administrator can fix it when no names are known', () => {
    expect(
      resolveEligibleProviderRecovery(
        unavailable('home_policy_prohibited', 'github_app_identity'),
        {
          viewerHomeRole: null,
          administratorNames: null,
        },
      ),
    ).toEqual({ kind: 'ask', names: [] });
  });

  it('offers nothing to recover for an available choice', () => {
    const available: TeamIdentityEligibleProviderV1 = {
      v: 1,
      providerId: null,
      providerKind: 'workos_sso',
      owner: 'team',
      displayName: null,
      availability: {
        status: 'available',
        setupChoice: {
          kind: 'create_managed',
          actionId: 'teams.identity.workos.connection.create',
        },
      },
    };
    expect(
      resolveEligibleProviderRecovery(available, {
        viewerHomeRole: 'owner',
        administratorNames: [],
      }),
    ).toEqual({ kind: 'none' });
  });

  it('treats the contact-an-administrator choice like a Home-owned prerequisite', () => {
    const contact: TeamIdentityEligibleProviderV1 = {
      v: 1,
      providerId: null,
      providerKind: 'oidc',
      owner: 'home',
      displayName: null,
      availability: {
        status: 'available',
        setupChoice: { kind: 'contact_home_admin' },
      },
    };
    expect(
      resolveEligibleProviderRecovery(contact, {
        viewerHomeRole: 'owner',
        administratorNames: [],
      }),
    ).toEqual({ kind: 'fix_on_home', destination: 'sign_in_providers' });
    expect(
      resolveEligibleProviderRecovery(contact, {
        viewerHomeRole: 'member',
        administratorNames: ['Ana Silva'],
      }),
    ).toEqual({ kind: 'ask', names: ['Ana Silva'] });
  });

  it('opens the exact row or page that fixes the reason, not the page that lists it', () => {
    // WorkOS credentials are a row on Sign-in providers that opens on arrival; the row's own link
    // owner supplies the address so the Team page never spells it itself.
    expect(
      eligibleProviderFixHref(
        'home-a',
        unavailable('workos_platform_unavailable'),
        'workos_platform',
      ),
    ).toBe(homeSignInPlatformHref('home-a', 'workos'));
    expect(
      eligibleProviderFixHref(
        'home-a',
        unavailable('workos_platform_unavailable'),
        'workos_platform',
      ),
    ).not.toBe(homeAdministrationSignInProvidersPath('home-a'));
    expect(
      eligibleProviderFixHref(
        'home-a',
        { ...unavailable('provider_disabled', 'oidc'), providerId: 'idp-1' },
        'home_provider',
      ),
    ).toBe(homeAdministrationIdentityProviderPath('home-a', 'idp-1'));
    expect(
      eligibleProviderFixHref(
        'home-a',
        unavailable('provider_setup_unavailable', 'oidc'),
        'reach',
      ),
    ).toBe(homeAdministrationReachPath('home-a'));
    expect(
      eligibleProviderFixHref(
        'home-a',
        unavailable('home_policy_prohibited', 'github_app_identity'),
        'team_rules',
      ).startsWith(homeAdministrationSignInProvidersPath('home-a')),
    ).toBe(true);
  });
});
