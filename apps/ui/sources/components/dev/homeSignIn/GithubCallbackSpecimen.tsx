import * as React from 'react';
import type { HomeSettingEntryV1 } from '@happier-dev/protocol/home/governance';

import type { HomeAdministrationContext } from '@/components/settings/home/governance/homeAdministrationContext';
import { HomeSignInPlatformsSection } from '@/components/settings/home/signInProviders/HomeSignInPlatformsSection';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import {
    homeGovernanceProjectionFixture,
    homeSettingEntryFixture,
    homeSettingsProjectionFixture,
} from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import type { HomeSettingsRead } from '@/hooks/home/useHomeSettings';

const githubEntry = (key: string, overrides?: Partial<HomeSettingEntryV1>) => homeSettingEntryFixture(key, {
    apply: 'restart',
    declaration: { type: key === 'GITHUB_REDIRECT_URL' ? 'url' : 'string', section: 'policies', group: 'github' },
    applied: { value: null, pending: false },
    ...overrides,
});

/**
 * Dev-only: the GitHub sign-in row of Home › Sign-in providers, opened, as an owner (`edit`) or an
 * administrator (`view`), with no callback saved (`unset`) or one saved (`set`). The Home answers at
 * studio.example.dev. Writes go nowhere.
 */
export function GithubCallbackSpecimen(props: Readonly<{ viewer: 'edit' | 'view'; callback: 'unset' | 'set' }>) {
    const projection = React.useMemo(() => {
        const base = homeGovernanceProjectionFixture();
        return props.viewer === 'view'
            ? { ...base, capabilities: { ...base.capabilities, manageAuthentication: false, manageHomeSettings: false } }
            : base;
    }, [props.viewer]);
    const settings = React.useMemo(() => homeSettingsProjectionFixture({
        entries: [
            githubEntry('GITHUB_CLIENT_ID', { value: 'Iv1.8a61f9b3a7aba766', source: 'home' }),
            githubEntry('GITHUB_CLIENT_SECRET', { secretSet: true, source: 'home' }),
            githubEntry('GITHUB_REDIRECT_URL', props.callback === 'set'
                ? { value: 'https://login.studio.example.dev/v1/oauth/github/callback', source: 'home' }
                : undefined),
        ],
        githubOAuthCallbackUrl: 'https://studio.example.dev/v1/oauth/github/callback',
    }), [props.callback]);
    const context = React.useMemo<HomeAdministrationContext>(() => ({
        scope: { serverId: 'specimen-home', accountId: 'specimen-owner' },
        homeName: 'Studio',
        projection,
        mutationsAvailable: true,
        approvalPending: false,
        refresh: () => {},
    }), [projection]);
    const home = React.useMemo<HomeSettingsRead>(() => ({
        settings,
        loading: false,
        failure: null,
        reload: async () => {},
        adoptSettings: () => {},
    }), [settings]);
    return (
        <ItemList>
            <PageHeader title="Sign-in providers" description="How people sign in to Studio." />
            <HomeSignInPlatformsSection context={context} home={home} />
        </ItemList>
    );
}
