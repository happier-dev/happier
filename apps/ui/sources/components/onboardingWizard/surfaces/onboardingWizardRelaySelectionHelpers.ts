import { Platform } from 'react-native';

import { isSameServerUrl, normalizeServerUrl } from '@/sync/domains/server/activeServerSwitch';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getOrCreateHappierCloudServerProfile, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';

import type { WizardRelaySelection } from '../wizardTypes';

function isExplicitLoopbackServerUrl(serverUrl: string): boolean {
    try {
        const url = new URL(serverUrl);
        const hostname = url.hostname.toLowerCase();
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch {
        return false;
    }
}

export function resolveTrueLocalRelayRuntimeBindUrl(params: Readonly<{
    activeServerUrl: string | null;
    activeLocalRelayUrl: string | null;
}>): string | null {
    const localCandidateRaw = typeof params.activeLocalRelayUrl === 'string' ? params.activeLocalRelayUrl.trim() : '';
    const localCandidate = localCandidateRaw ? (normalizeServerUrl(localCandidateRaw) ?? localCandidateRaw) : '';
    if (localCandidate && isExplicitLoopbackServerUrl(localCandidate)) return localCandidate;

    const serverCandidateRaw = typeof params.activeServerUrl === 'string' ? params.activeServerUrl.trim() : '';
    const serverCandidate = serverCandidateRaw ? (normalizeServerUrl(serverCandidateRaw) ?? serverCandidateRaw) : '';
    if (serverCandidate && isExplicitLoopbackServerUrl(serverCandidate)) return serverCandidate;

    return null;
}

export function isWebMixedContentBlockedEndpoint(serverUrl: string): boolean {
    if (Platform.OS !== 'web') return false;
    try {
        const endpointProtocol = new URL(serverUrl).protocol;
        const pageProtocol = (globalThis as unknown as { location?: { protocol?: string } }).location?.protocol;
        return pageProtocol === 'https:' && endpointProtocol === 'http:';
    } catch {
        return false;
    }
}

export function resolveCanonicalCloudRelayProfile(): Readonly<{ serverId: string; serverUrl: string }> | null {
    const setupPolicy = resolveSetupSurfacePolicy();
    if (!setupPolicy.relay.allowHappierCloud) return null;
    const profile = getOrCreateHappierCloudServerProfile();
    const serverUrl = profile?.serverUrl ? normalizeServerUrl(profile.serverUrl) : '';
    if (!profile || !serverUrl) return null;
    return { serverId: profile.id, serverUrl };
}

export function buildDefaultRelaySelection(): WizardRelaySelection {
    const snapshot = getActiveServerSnapshot();
    const serverUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
    const setupPolicy = resolveSetupSurfacePolicy();
    const canonicalCloudProfile = resolveCanonicalCloudRelayProfile();
    const canonicalCloudUrl = canonicalCloudProfile?.serverUrl ?? '';
    const savedProfiles = listServerProfiles()
        .map((profile) => ({
            id: profile.id,
            serverUrl: normalizeServerUrl(profile.serverUrl) ?? profile.serverUrl,
        }))
        .filter((profile) => profile.serverUrl && (!canonicalCloudUrl || !isSameServerUrl(profile.serverUrl, canonicalCloudUrl)));

    if (setupPolicy.relay.enforcedServerUrl) {
        const enforcedRaw = String(setupPolicy.relay.enforcedServerUrl).trim();
        const enforced = enforcedRaw ? (normalizeServerUrl(enforcedRaw) ?? enforcedRaw) : '';
        if (!enforced) {
            return {
                choiceId: 'customUrl',
                serverUrl: null,
                relayProfileId: null,
                locked: true,
            };
        }

        const matchingProfile = savedProfiles.find((profile) => isSameServerUrl(profile.serverUrl, enforced));
        return {
            choiceId: 'customUrl',
            serverUrl: enforced,
            relayProfileId: matchingProfile?.id ?? 'active',
            locked: true,
        };
    }

    if (serverUrl) {
        const matchingProfile = savedProfiles.find((profile) => isSameServerUrl(profile.serverUrl, serverUrl));
        if (matchingProfile) {
            return {
                choiceId: 'customUrl',
                serverUrl,
                relayProfileId: matchingProfile.id,
                locked: false,
            };
        }
    }

    if (serverUrl) {
        const matchesCloud = canonicalCloudUrl ? isSameServerUrl(serverUrl, canonicalCloudUrl) : false;
        return {
            choiceId: matchesCloud ? 'cloud' : 'customUrl',
            serverUrl,
            relayProfileId: matchesCloud ? null : 'active',
            locked: false,
        };
    }

    return {
        choiceId: canonicalCloudUrl ? 'cloud' : 'customUrl',
        serverUrl: canonicalCloudUrl || null,
        relayProfileId: null,
        locked: false,
    };
}

export function resolveRelayProfileIdForServerUrl(params: Readonly<{
    serverUrl: string | null;
    canonicalCloudUrl: string;
}>): string | null {
    const raw = typeof params.serverUrl === 'string' ? params.serverUrl.trim() : '';
    const normalized = raw ? (normalizeServerUrl(raw) ?? raw) : '';
    if (!normalized) return null;
    if (params.canonicalCloudUrl && isSameServerUrl(normalized, params.canonicalCloudUrl)) return null;

    const match = listServerProfiles().find((profile) => {
        const profileUrl = profile?.serverUrl ? normalizeServerUrl(profile.serverUrl) : '';
        return Boolean(profileUrl) && isSameServerUrl(profileUrl, normalized);
    });

    return match?.id ?? 'active';
}
