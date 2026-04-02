import { isActiveServerSelectionExplicit } from '@/sync/domains/server/serverRuntime';
import { isSameServerUrl, normalizeServerUrl } from '@/sync/domains/server/activeServerSwitch';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { isLocalishServerUrl } from '@/sync/domains/server/url/serverUrlClassification';
import { t } from '@/text';

import type { WizardProfileChoice } from './relaySelectionTypes';
import { resolveCanonicalCloudRelayProfile } from './relaySelectionHelpers';

export function buildRelayProfileChoices(params: Readonly<{
    relaySelectionServerUrl: string | null | undefined;
    relaySelectionChoiceId: string;
    activeServerUrl: string | null | undefined;
}>): readonly WizardProfileChoice[] {
    const canonicalCloudProfile = resolveCanonicalCloudRelayProfile();
    const canonicalCloudUrl = canonicalCloudProfile?.serverUrl ?? '';
    const profiles = listServerProfiles()
        .filter((profile) => {
            const serverUrl = profile?.serverUrl ? normalizeServerUrl(profile.serverUrl) : '';
            if (!serverUrl) return false;
            if (canonicalCloudUrl && isSameServerUrl(serverUrl, canonicalCloudUrl)) return false;
            return true;
        })
        .map((profile) => ({
            kind: 'profile' as const,
            id: profile.id,
            name: profile.name,
            serverUrl: normalizeServerUrl(profile.serverUrl) ?? profile.serverUrl,
        }));

    const selectionServerUrl = normalizeServerUrl(params.relaySelectionServerUrl ?? '') ?? '';
    const knownPrefilledUrl = selectionServerUrl || (normalizeServerUrl(params.activeServerUrl ?? '') ?? '');
    if (
        knownPrefilledUrl
        && (!canonicalCloudUrl || !isSameServerUrl(knownPrefilledUrl, canonicalCloudUrl))
        && !(isLocalishServerUrl(knownPrefilledUrl) && isActiveServerSelectionExplicit() && params.relaySelectionChoiceId === 'thisComputer')
    ) {
        const alreadyListed = profiles.some((existing) => isSameServerUrl(existing.serverUrl, knownPrefilledUrl));
        if (!alreadyListed) {
            profiles.unshift({
                kind: 'profile' as const,
                id: 'active',
                name: t('setupOnboarding.currentRelayTitle'),
                serverUrl: knownPrefilledUrl,
            });
        }
    }

    return profiles;
}
