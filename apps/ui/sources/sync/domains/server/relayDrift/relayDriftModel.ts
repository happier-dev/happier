import { createServerUrlComparableKey } from '@happier-dev/protocol';

export type RelayDriftRepairAction = Readonly<{
    kind: 'connectBackgroundServiceToActiveRelay';
}>;

export type RelayDriftClassification =
    | Readonly<{ status: 'aligned'; repairAction: null }>
    | Readonly<{ status: 'daemon_not_configured'; repairAction: RelayDriftRepairAction }>
    | Readonly<{ status: 'daemon_not_installed'; repairAction: RelayDriftRepairAction }>
    | Readonly<{ status: 'daemon_not_running'; repairAction: RelayDriftRepairAction }>
    | Readonly<{ status: 'daemon_url_mismatch'; repairAction: RelayDriftRepairAction }>
    | Readonly<{ status: 'daemon_needs_auth'; repairAction: RelayDriftRepairAction }>;

export function createRelayUrlComparableKeySafe(rawUrl: string | null | undefined): string | null {
    const value = String(rawUrl ?? '').trim();
    if (!value) return null;
    try {
        return createServerUrlComparableKey(value);
    } catch {
        return null;
    }
}

export function resolveKnownRelayEquivalentUrl(params: Readonly<{
    activeRelayUrl: string | null | undefined;
    daemonRelayUrl: string | null | undefined;
    daemonAlternateRelayUrls?: readonly (string | null | undefined)[];
}>): string | null {
    const activeRelayKey = createRelayUrlComparableKeySafe(params.activeRelayUrl);
    if (!activeRelayKey) {
        return null;
    }

    const candidates = [
        params.daemonRelayUrl,
        ...(params.daemonAlternateRelayUrls ?? []),
    ];

    const keyedCandidates = candidates
        .map((url) => {
            const normalizedUrl = typeof url === 'string' ? url.trim() : '';
            const key = createRelayUrlComparableKeySafe(normalizedUrl);
            return normalizedUrl && key ? { url: normalizedUrl, key } : null;
        })
        .filter((candidate): candidate is { url: string; key: string } => candidate != null);

    const matchingCandidate = keyedCandidates.find((candidate) => candidate.key === activeRelayKey);
    if (!matchingCandidate) {
        return null;
    }

    const alternateCandidate = keyedCandidates.find((candidate) => candidate.key !== matchingCandidate.key);
    return alternateCandidate?.url ?? null;
}

export function classifyRelayDrift(params: Readonly<{
    activeRelayUrl: string | null | undefined;
    activeLocalRelayUrl?: string | null | undefined;
    daemonRelayUrl: string | null | undefined;
    daemonAlternateRelayUrls?: readonly (string | null | undefined)[];
    daemonAccountId: string | null | undefined;
    daemonNeedsAuth?: boolean | null | undefined;
    daemonServiceInstalled?: boolean | null | undefined;
    daemonRunning?: boolean | null | undefined;
}>): RelayDriftClassification {
    const activeRelayKey = createRelayUrlComparableKeySafe(params.activeRelayUrl);
    if (!activeRelayKey) {
        return { status: 'aligned', repairAction: null };
    }

    const acceptedRelayKeys = new Set<string>([activeRelayKey]);
    const activeLocalRelayKey = createRelayUrlComparableKeySafe(params.activeLocalRelayUrl);
    if (activeLocalRelayKey) {
        acceptedRelayKeys.add(activeLocalRelayKey);
    }

    const daemonRelayKeys = new Set<string>();
    const primaryDaemonRelayKey = createRelayUrlComparableKeySafe(params.daemonRelayUrl);
    if (primaryDaemonRelayKey) {
        daemonRelayKeys.add(primaryDaemonRelayKey);
    }
    for (const candidate of params.daemonAlternateRelayUrls ?? []) {
        const candidateKey = createRelayUrlComparableKeySafe(candidate);
        if (candidateKey) {
            daemonRelayKeys.add(candidateKey);
        }
    }

    if (daemonRelayKeys.size === 0) {
        return {
            status: 'daemon_not_configured',
            repairAction: { kind: 'connectBackgroundServiceToActiveRelay' },
        };
    }

    const isAligned = [...daemonRelayKeys].some((daemonRelayKey) => acceptedRelayKeys.has(daemonRelayKey));
    if (!isAligned) {
        return {
            status: 'daemon_url_mismatch',
            repairAction: { kind: 'connectBackgroundServiceToActiveRelay' },
        };
    }

    if (params.daemonServiceInstalled === false) {
        return {
            status: 'daemon_not_installed',
            repairAction: { kind: 'connectBackgroundServiceToActiveRelay' },
        };
    }

    if (params.daemonServiceInstalled === true && params.daemonRunning === false) {
        return {
            status: 'daemon_not_running',
            repairAction: { kind: 'connectBackgroundServiceToActiveRelay' },
        };
    }

    if (params.daemonNeedsAuth === true) {
        return {
            status: 'daemon_needs_auth',
            repairAction: { kind: 'connectBackgroundServiceToActiveRelay' },
        };
    }

    if (!String(params.daemonAccountId ?? '').trim()) {
        return {
            status: 'daemon_needs_auth',
            repairAction: { kind: 'connectBackgroundServiceToActiveRelay' },
        };
    }

    return { status: 'aligned', repairAction: null };
}
