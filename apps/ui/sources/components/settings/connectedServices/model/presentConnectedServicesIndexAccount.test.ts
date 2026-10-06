import { describe, expect, it } from 'vitest';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol';

import type { ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { presentConnectedAccountIdentity } from '@/sync/domains/connectedServices/maskAccountEmail';

import { buildConnectedServicesIndexModel } from './buildConnectedServicesIndexModel';
import { presentConnectedServicesIndexAccount } from './presentConnectedServicesIndexAccount';

const SERVICE_ID = 'claude-subscription';
const ENTRY: ConnectedServiceRegistryEntry = {
    serviceId: SERVICE_ID, legacyServiceId: SERVICE_ID,
    service: { pluginId: 'happier.agent.claude', localId: SERVICE_ID },
    connectCommand: 'happier connect claude', supportsOauth: true, executable: true,
};
const PROFILES = [
    { profileId: 'profile-id-42', status: 'connected' },
    { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
    { profileId: 'named', status: 'connected', providerAccountId: 'provider-account-42' },
    { profileId: 'at-sign', status: 'connected', providerAccountId: 'provider@example.com' },
];

function presentLegacy(hidden: boolean, labelsByKey: Readonly<Record<string, string | undefined>> = {}) {
    // The live Collection index admits released V2 records through this same generated adapter.
    const model = buildConnectedServicesIndexModel({
        transport: 'legacy', entries: [ENTRY],
        qualifiedAccounts: [], qualifiedGroups: [],
        legacyServices: [{ serviceId: SERVICE_ID, profiles: PROFILES }],
        defaultAccountByServiceKey: {}, resolveLabel: () => 'Claude',
        resolveFallbackEntry: () => null,
        presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading',
    });
    const sheet = model.sheets[0]!;
    return Object.fromEntries(sheet.accounts.map((account) => [
        account.accountId,
        presentConnectedServicesIndexAccount(sheet, account, labelsByKey, (input) => presentConnectedAccountIdentity({
            ...input, hidden, label: input.label ?? null, email: input.email ?? null, accountId: input.accountId ?? null,
        })),
    ]));
}

describe('presentConnectedServicesIndexAccount privacy for released profiles', () => {
    it('keeps the provider UUID out of the subtitle when an email identifies a qualified account', () => {
        const profile: QualifiedConnectedAccountProfileV4 = {
            ref: { service: ENTRY.service!, accountId: 'internal-account-id' },
            status: 'connected', authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
            credentialRevision: 'credential-1', configurationReady: true, configurationRevision: null,
            scopes: [], providerIdentity: { email: 'you@example.com', accountId: '00ae5eea-6286-48bc-b82a-30a5f8492864' },
        };
        const model = buildConnectedServicesIndexModel({
            transport: 'advertised-v4', entries: [ENTRY], qualifiedAccounts: [profile], qualifiedGroups: [],
            legacyServices: [], defaultAccountByServiceKey: {}, resolveLabel: () => 'Claude',
            resolveFallbackEntry: () => null, presentDiagnostics: () => ({ primary: null, supportDetails: null }),
            loadingLabel: 'Loading',
        });
        const sheet = model.sheets[0]!;
        const shown = presentConnectedServicesIndexAccount(sheet, sheet.accounts[0]!, {}, (input) => presentConnectedAccountIdentity({
            ...input, hidden: false, label: input.label ?? null, email: input.email ?? null, accountId: input.accountId ?? null,
        }));
        expect(shown.title).toBe('you@example.com');
        expect(shown.identityLabel).toBeNull();
        // The actual provider id remains available to intentional detail/support surfaces.
        expect(shown.accountIdLabel).toBe(profile.providerIdentity!.accountId);
    });

    it('masks an id fallback and an email used as a user label through the same privacy owner', () => {
        const presentation = presentLegacy(true, {
            [connectedServiceProfileKey({ serviceId: SERVICE_ID, profileId: 'work' })]: 'work@example.com',
            [connectedServiceProfileKey({ serviceId: SERVICE_ID, profileId: 'named' })]: 'Primary',
        });
        expect(presentation['profile-id-42']?.title).toBe('profi•••42');
        expect(presentation.work?.title).toBe('wo•••@e•••.com');
        expect(presentation.named).toMatchObject({ title: 'Primary', identityLabel: 'provi•••42' });
        expect(presentation['at-sign']?.title).toBe('provi•••om');
    });

    it('preserves user names and restores released identities when privacy is off', () => {
        const labels = { [connectedServiceProfileKey({ serviceId: SERVICE_ID, profileId: 'named' })]: 'provider-account-42' };
        expect(presentLegacy(true, labels).named?.title).toBe('provider-account-42');
        const visible = presentLegacy(false, labels);
        expect(visible['profile-id-42']?.title).toBe('profile-id-42');
        expect(visible.work?.title).toBe('work@example.com');
        expect(visible.named).toMatchObject({ title: 'provider-account-42', identityLabel: 'provider-account-42' });
    });
});
