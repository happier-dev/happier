import { Platform } from 'react-native';

import { classifyAccessEndpointHostedHttpsCompatibility } from '@/sync/domains/accessEndpoints/classify';
import { isSameServerUrl, normalizeServerUrl } from '@/sync/domains/server/activeServerSwitch';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { HAPPIER_CLOUD_SERVER_URL, getOrCreateHappierCloudServerProfile, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import type { WizardRelaySelection } from '../../state/wizardTypes';

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
    const pageProtocol = (globalThis as unknown as { location?: { protocol?: string } }).location?.protocol;
    return classifyAccessEndpointHostedHttpsCompatibility({
        httpBaseUrl: serverUrl,
        clientContext: pageProtocol === 'https:' ? 'hosted-https-web' : 'web',
    }) === 'mixed-content-blocked';
}

type CanonicalCloudRelayProfile = Readonly<{ serverId: string | null; serverUrl: string }>;

export function resolveCanonicalCloudRelayProfile(): CanonicalCloudRelayProfile | null {
    const setupPolicy = resolveSetupSurfacePolicy();
    if (!setupPolicy.relay.allowHappierCloud) return null;
    const serverUrl = normalizeServerUrl(HAPPIER_CLOUD_SERVER_URL) ?? HAPPIER_CLOUD_SERVER_URL;
    const existing = listServerProfiles().find((profile) => {
        const profileUrl = profile?.serverUrl ? normalizeServerUrl(profile.serverUrl) : '';
        return Boolean(profileUrl) && isSameServerUrl(profileUrl, serverUrl);
    });
    return { serverId: existing?.id ?? null, serverUrl };
}

export function ensureCanonicalCloudRelayProfile(): Readonly<{ serverId: string; serverUrl: string }> | null {
    const resolved = resolveCanonicalCloudRelayProfile();
    if (!resolved) return null;
    if (resolved.serverId) return { serverId: resolved.serverId, serverUrl: resolved.serverUrl };

    const profile = getOrCreateHappierCloudServerProfile();
    const serverUrl = profile?.serverUrl ? normalizeServerUrl(profile.serverUrl) : '';
    if (!profile || !serverUrl) return null;
    return { serverId: profile.id, serverUrl };
}

export function buildDefaultRelaySelection(): WizardRelaySelection {
    const snapshot = getActiveServerSnapshot();
    const serverUrlRaw = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
    const serverUrl = serverUrlRaw ? (normalizeServerUrl(serverUrlRaw) ?? serverUrlRaw) : '';
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
                relayProfileId: matchingProfile.id,
                serverUrl: null,
                locked: false,
            };
        }
    }

    if (serverUrl) {
        const matchesCloud = canonicalCloudUrl ? isSameServerUrl(serverUrl, canonicalCloudUrl) : false;
        return {
            choiceId: matchesCloud ? 'cloud' : 'customUrl',
            // Default selection should follow the *active* server snapshot at render time, not
            // freeze a serverUrl into wizard state (the active relay can change externally).
            serverUrl: null,
            relayProfileId: matchesCloud ? null : 'active',
            locked: false,
        };
    }

    return {
        choiceId: canonicalCloudUrl ? 'cloud' : 'customUrl',
        serverUrl: null,
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

export function resolveRelaySwitchUrl(params: Readonly<{
    relayRuntimeUrl: string | null;
    relayAccessShareUrl: string | null;
    relayAccessTarget: RelayAccessTaskTarget | null;
}>): string | null {
    const relayRuntimeUrlRaw = typeof params.relayRuntimeUrl === 'string' ? params.relayRuntimeUrl.trim() : '';
    const relayRuntimeUrl = relayRuntimeUrlRaw ? (normalizeServerUrl(relayRuntimeUrlRaw) ?? relayRuntimeUrlRaw) : '';
    const relayAccessShareUrlRaw = typeof params.relayAccessShareUrl === 'string' ? params.relayAccessShareUrl.trim() : '';
    const relayAccessShareUrl = relayAccessShareUrlRaw ? (normalizeServerUrl(relayAccessShareUrlRaw) ?? relayAccessShareUrlRaw) : '';

    if (params.relayAccessTarget?.kind === 'ssh' && relayAccessShareUrl) {
        return relayAccessShareUrl;
    }

    return relayRuntimeUrl || null;
}
