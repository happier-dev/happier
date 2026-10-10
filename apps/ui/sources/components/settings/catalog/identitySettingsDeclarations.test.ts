import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import { SETTINGS_PAGE_DECLARATIONS } from './settingsPageDeclarations';
import { buildSettingHref, defineSettingsPage } from './settingDeclarations';
import { SERVER_CONFIG_REGISTRY_BASE } from '@happier-dev/protocol/serverConfig/registry';
import { HOME_SERVER_SETTINGS } from '@/components/settings/home/governance/homeServerSettings';
import { readBuiltInSettingDeclarationV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';

function destination(anchor: string, pathname: string, params: Record<string, string | string[]>): string | null {
    const declaration = SETTINGS_PAGE_DECLARATIONS.find((page) => Object.values(page.settings).some((setting) => setting.anchor === anchor));
    expect(declaration, `Search must declare ${anchor}`).toBeDefined();
    const setting = Object.values(declaration!.settings).find((setting) => setting.anchor === anchor)!;
    const route = declaration!.subpage?.route;
    return route ? buildSettingHref(route, setting, { pathname, params }) : null;
}

describe('scoped identity setting destinations', () => {
    it('does not create an unregistered built-in metadata owner in a UI page', () => {
        expect(() => defineSettingsPage({ pageId: 'appearance', sections: {
            display: { settings: { undeclaredPreference: { titleKey: 'common.enabled' } } },
        } })).toThrow('Undeclared built-in setting');
    });
    it('projects every built-in page row from the shared portable declaration', () => {
        for (const page of SETTINGS_PAGE_DECLARATIONS) for (const row of Object.values(page.settings)) {
            const portable = readBuiltInSettingDeclarationV1(row.anchor);
            expect(portable, row.anchor).not.toBeNull();
            expect(row.titleKey, row.anchor).toBe(portable!.titleKey);
            expect(row.descriptionKey, row.anchor).toBe(portable!.descriptionKey);
            expect(row.storage?.scope, row.anchor).toBe(portable!.storage?.scope);
            expect(row.storage?.access, row.anchor).toBe(portable!.storage?.access);
        }
    });
    it('keeps secret Home registry fields discoverable without advertising public values', () => {
        const declaredSecrets = Object.entries(SERVER_CONFIG_REGISTRY_BASE)
            .filter(([key, entry]) => entry.sensitivity === 'secret' && HOME_SERVER_SETTINGS.settings[key]);
        expect(declaredSecrets.length).toBeGreaterThan(0);
        for (const [key] of declaredSecrets) {
            expect(HOME_SERVER_SETTINGS.settings[key]?.sensitive, key).toBe(true);
        }
        expect(HOME_SERVER_SETTINGS.settings.PORT).toBeDefined();
        expect(HOME_SERVER_SETTINGS.settings.PORT?.sensitive).not.toBe(true);
    });
    it('opens the exact Home OIDC editor and rejects another route or ambiguous Home', () => {
        const path = '/settings/home/home-b/sign-in-providers/identity/provider-one/edit';
        const params = { serverId: 'home-b', providerId: 'provider-one' };
        expect(destination('homeAdministration.oidc.issuer', path, params)).toBe(`${path}?setting=homeAdministration.oidc.issuer`);
        expect(destination('homeAdministration.oidc.issuer', '/settings', params)).toBeNull();
        expect(destination('homeAdministration.oidc.issuer', path, { ...params, serverId: 'home-a' })).toBeNull();
        expect(destination('homeAdministration.oidc.issuer', path, { ...params, serverId: ['home-a', 'home-b'] })).toBeNull();
        const detailPath = '/settings/home/home-b/sign-in-providers/identity/provider-one';
        expect(destination('homeAdministration.identityProvider.disable', detailPath, params)).toBe(`${detailPath}?setting=homeAdministration.identityProvider.disable`);
        expect(destination('homeAdministration.identityProvider.disable', path, params)).toBeNull();
    });

    it('retains Team provider identity and never chooses a connection from another Team', () => {
        const path = '/settings/teams/home-b/team-one/authentication/connection-one/edit';
        const params = { serverId: 'home-b', teamId: 'team-one', connectionId: 'connection-one', providerId: 'provider-one' };
        expect(destination('teams.oidc.issuer', path, params)).toBe(`${path}?providerId=provider-one&setting=teams.oidc.issuer`);
        expect(destination('teams.oidc.issuer', path, { ...params, teamId: 'team-two' })).toBeNull();
        expect(destination('teams.oidc.issuer', '/settings/teams', params)).toBeNull();
    });

    it('keeps Home WorkOS detail and setup on the captured Home without Team-only settings', () => {
        const detailPath = '/settings/home/home-b/sign-in-providers/connections/connection-one';
        const params = { serverId: 'home-b', connectionId: 'connection-one' };
        expect(destination('homeAdministration.identityConnection.test', detailPath, params)).toBe(`${detailPath}?setting=homeAdministration.identityConnection.test`);
        expect(destination('homeAdministration.identityConnection.test', detailPath, { ...params, serverId: 'home-a' })).toBeNull();
        expect(destination('homeAdministration.identityConnection.test', '/settings/home/home-b', params)).toBeNull();
        const createPath = '/settings/home/home-b/sign-in-providers/connections/new';
        expect(destination('homeAdministration.workosSetup.companyName', createPath, { serverId: 'home-b' })).toBe(`${createPath}?setting=homeAdministration.workosSetup.companyName`);
        expect(destination('homeAdministration.workosSetup.companyName', detailPath, params)).toBeNull();
        const page = SETTINGS_PAGE_DECLARATIONS.find((declaration) => declaration.settings.test?.anchor === 'homeAdministration.identityConnection.test');
        expect(Object.keys(page!.settings)).not.toContain('workosSetupDirectory');
        expect(Object.keys(page!.settings)).not.toContain('groupMappings');
    });

    it('only finds Team WorkOS draft fields on the named WorkOS creation route', () => {
        const path = '/settings/teams/home-b/team-one/authentication/new';
        const params = { serverId: 'home-b', teamId: 'team-one', kind: 'workos_sso' };
        expect(destination('teams.workosSetup.companyName', path, params)).toBe(`${path}?kind=workos_sso&setting=teams.workosSetup.companyName`);
        expect(destination('teams.workosSetup.companyName', path, { ...params, kind: 'oidc' })).toBeNull();
        expect(destination('teams.workosSetup.companyName', path, { ...params, teamId: 'team-two' })).toBeNull();
    });

    it('keeps GitHub setup distinct from OIDC and detail distinct from editing', () => {
        const createPath = '/settings/teams/home-b/team-one/authentication/new';
        const params = { serverId: 'home-b', teamId: 'team-one', kind: 'github_app_identity' };
        expect(destination('teams.githubAppEditor.githubHost', createPath, params)).toBe(`${createPath}?kind=github_app_identity&setting=teams.githubAppEditor.githubHost`);
        expect(destination('teams.oidc.issuer', createPath, params)).toBeNull();
        expect(destination('teams.oidc.issuer', createPath, { ...params, kind: ['oidc', 'github_app_identity'] })).toBeNull();
        const detailPath = '/settings/home/home-b/sign-in-providers/github-apps/registration-one';
        const detailParams = { serverId: 'home-b', registrationId: 'registration-one' };
        expect(destination('homeAdministration.githubApp.githubHost', detailPath, detailParams)).toBe(`${detailPath}?setting=homeAdministration.githubApp.githubHost`);
        expect(destination('homeAdministration.githubAppEditor.githubHost', detailPath, detailParams)).toBeNull();
        expect(destination('homeAdministration.githubApp.githubHost', detailPath, { ...detailParams, registrationId: 'registration-two' })).toBeNull();
    });

    it('links Team-wide policy and directory controls only within an explicit matching Team', () => {
        const path = '/settings/teams/home-b/team-one/authentication/directory/source-one';
        const params = { serverId: 'home-b', teamId: 'team-one', sourceId: 'source-one' };
        expect(destination('teams.authentication.acceptedMethods', path, params)).toBe('/settings/teams/home-b/team-one/authentication?setting=teams.authentication.acceptedMethods');
        expect(destination('teams.directory.addSource', path, params)).toBe('/settings/teams/home-b/team-one/authentication/directory?setting=teams.directory.addSource');
        expect(destination('teams.directorySource.searchGroups', path, params)).toBe(`${path}?setting=teams.directorySource.searchGroups`);
        expect(destination('teams.directorySource.remove', path, { ...params, sourceId: 'source-two' })).toBeNull();
        expect(destination('teams.authentication.acceptedMethods', path, { ...params, serverId: 'home-a' })).toBeNull();
        expect(destination('teams.directory.addSource', '/settings/home/home-b/policies', params)).toBeNull();
        const connectionPath = '/settings/teams/home-b/team-one/authentication/connection-one';
        expect(destination('teams.identityConnection.externalGroupId', connectionPath, { serverId: 'home-b', teamId: 'team-one', connectionId: 'connection-one' })).toBe(`${connectionPath}?setting=teams.identityConnection.externalGroupId`);
        expect(destination('teams.authentication.addGitHubApp', path, params)).toBe('/settings/teams/home-b/team-one/authentication?setting=teams.authentication.addGitHubApp');
    });

    it('opens identity and provisioning policy on the named Home without indexing its methods', () => {
        const params = { serverId: 'home-b' };
        expect(destination('homeAdministration.authenticationPolicy.recommendedProvisioningMode', '/settings/home/home-b', params)).toBe('/settings/home/home-b/policies?setting=homeAdministration.authenticationPolicy.recommendedProvisioningMode');
        expect(destination('homeAdministration.authenticationPolicy.permittedAccountModes', '/settings/home/home-a', params)).toBeNull();
        expect(destination('homeAdministration.authenticationPolicy.enabledMethodIds', '/settings/teams/home-b/team-one', params)).toBeNull();
        // Providers, GitHub Apps, private endpoints and Team rules are found on Sign-in providers.
        expect(destination('homeAdministration.signInProviders.addProvider', '/settings/home/home-b', params)).toBe('/settings/home/home-b/sign-in-providers?setting=homeAdministration.signInProviders.addProvider');
        expect(destination('homeAdministration.signInProviders.addGitHubApp', '/settings/home/home-b', params)).toBe('/settings/home/home-b/sign-in-providers?setting=homeAdministration.signInProviders.addGitHubApp');
        expect(destination('homeAdministration.signInProviders.teamJitAllowed', '/settings/home/home-b', params)).toBe('/settings/home/home-b/sign-in-providers?setting=homeAdministration.signInProviders.teamJitAllowed');
        expect(destination('homeAdministration.signInProviders.hostnames', '/settings/home/home-a', params)).toBeNull();
    });
});
