import { describe, expect, it } from 'vitest';
import { listAccountSettingsSavedSecretReferences, formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { projectConnectedAccountCredentialReferenceSources } from '@/sync/domains/connectedServices/connectedAccountCredentialReferenceSources';
import { connectedServiceProfileKey, qualifiedConnectedAccountPreferenceServiceKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';

import { savedSecretUsedByCopy } from './savedSecretRowCopy';

describe('Saved Secret Used by presentation', () => {
    it('presents the resource identity supplied by the reference owner', () => {
        const copy = savedSecretUsedByCopy({
            owner: 'provider',
            path: 'providerConnectionsCatalog.secretBindingsByConnectionId["pc_work"].account.apiKey',
            referrer: { kind: 'provider', id: 'pc_work', displayName: 'Studio models' },
        });
        expect(copy.title).toBe('Studio models');
        expect(copy.subtitle).toBe('Model provider');
        expect(JSON.stringify(copy)).not.toContain('pc_work');
        expect(JSON.stringify(copy)).not.toContain('secretBindingsByConnectionId');
    });

    it('names a connected credential and its kind from the canonical reference census', () => {
        const [reference] = listAccountSettingsSavedSecretReferences({}, formatSharedSavedSecretRefV1('work-key'), {
            profileRecords: [], connectedAccountCredentials: [{
                account: { service: { pluginId: 'service.plugin', localId: 'api' }, accountId: 'work' },
                displayName: 'Work credential', savedSecretResourceIds: ['work-key'],
            }],
        });
        expect(reference).toBeDefined();
        expect(savedSecretUsedByCopy(reference!)).toEqual({ title: 'Work credential', subtitle: 'Connected account' });
    });

    it('keeps unidentified references readable without exposing their internal path', () => {
        const copy = savedSecretUsedByCopy({ owner: 'unknown', path: 'futureSettings.privateCarrier' });
        expect(copy.title).toBeTruthy();
        expect(JSON.stringify(copy)).not.toContain('futureSettings');
    });

    it('presents an unnamed credential through the canonical account fallback without exposing its routing id', () => {
        const credentials = projectConnectedAccountCredentialReferenceSources([{
            ref: { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, accountId: 'private-routing-handle' },
            scopes: [], status: 'connected', authenticationModeId: 'api-key', revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationReady: true, configurationRevision: null,
            savedSecretResourceIds: ['unnamed-key'],
        }], {});
        const [reference] = listAccountSettingsSavedSecretReferences({}, formatSharedSavedSecretRefV1('unnamed-key'), {
            profileRecords: [], connectedAccountCredentials: credentials,
        });
        expect(reference).toBeDefined();
        expect(savedSecretUsedByCopy(reference!)).toEqual({ title: 'Anthropic account', subtitle: 'Connected account' });
    });

    it('uses the person’s canonical account label ahead of the provider display name in delete review', () => {
        const account = { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, accountId: 'private-routing-handle' };
        const labelKey = connectedServiceProfileKey({ serviceId: qualifiedConnectedAccountPreferenceServiceKey(account.service),
            profileId: account.accountId });
        const credentials = projectConnectedAccountCredentialReferenceSources([{
            ref: account, scopes: [], displayName: 'Provider name', status: 'connected', authenticationModeId: 'api-key', revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationReady: true, configurationRevision: null,
            savedSecretResourceIds: ['named-key'],
        }], { [labelKey]: 'My work credential' });
        const [reference] = listAccountSettingsSavedSecretReferences({}, formatSharedSavedSecretRefV1('named-key'), {
            profileRecords: [], connectedAccountCredentials: credentials,
        });
        expect(reference).toBeDefined();
        expect(savedSecretUsedByCopy(reference!)).toEqual({ title: 'My work credential', subtitle: 'Connected account' });
    });
});
