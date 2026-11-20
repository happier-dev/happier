import { isActiveServerSelectionExplicit } from '@/sync/domains/server/serverRuntime';
import { isSameServerUrl, normalizeServerUrl } from '@/sync/domains/server/activeServerSwitch';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { isLocalishServerUrl } from '@/sync/domains/server/url/serverUrlClassification';
import { t } from '@/text';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';

import type { WizardProfileChoice } from './relaySelectionTypes';
import { resolveCanonicalCloudRelayProfile } from './relaySelectionHelpers';

export function buildRelayProfileChoices(params: Readonly<{
    relaySelectionServerUrl: string | null | undefined;
    relaySelectionChoiceId: string;
    activeServerUrl: string | null | undefined;
}>): readonly WizardProfileChoice[] {
    const canonicalCloudProfile = resolveCanonicalCloudRelayProfile();
    const canonicalCloudUrl = canonicalCloudProfile?.serverUrl ?? '';
    const selectionServerUrl = normalizeServerUrl(params.relaySelectionServerUrl ?? '') ?? '';
    const activeServerUrl = normalizeServerUrl(params.activeServerUrl ?? '') ?? '';
    // Plan 03 U6: "Where should your Home live?" offers places for a Home. The Home already in use is
    // named above the step, not offered again; a policy-locked Home stays as the only allowed choice.
    const policyLocked = Boolean(resolveSetupSurfacePolicy().relay.enforcedServerUrl);
    const isCurrentHome = (serverUrl: string) => !policyLocked && Boolean(activeServerUrl)
        && isSameServerUrl(serverUrl, activeServerUrl)
        && !(selectionServerUrl && isSameServerUrl(serverUrl, selectionServerUrl));
    const profiles = listServerProfiles()
        .filter((profile) => {
            const serverUrl = profile?.serverUrl ? normalizeServerUrl(profile.serverUrl) : '';
            if (!serverUrl) return false;
            if (canonicalCloudUrl && isSameServerUrl(serverUrl, canonicalCloudUrl)) return false;
            return !isCurrentHome(serverUrl);
        })
        .map((profile) => ({
            kind: 'profile' as const,
            id: profile.id,
            name: resolveHomeDisplayLabel(profile, profile.id),
            serverUrl: normalizeServerUrl(profile.serverUrl) ?? profile.serverUrl,
        }));

    const knownPrefilledUrl = selectionServerUrl || (policyLocked ? activeServerUrl : '');
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
