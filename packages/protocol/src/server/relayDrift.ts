import { createServerUrlComparableKey } from './urls/serverUrlComparableKey.js';

export type RelayDriftRepairAction = Readonly<{
    kind: 'connectBackgroundServiceToActiveRelay';
}>;

export type RelayDriftClassification =
    | Readonly<{ status: 'aligned'; repairAction: null }>
    | Readonly<{ status: 'daemon_not_configured'; repairAction: RelayDriftRepairAction }>
    | Readonly<{ status: 'daemon_not_installed'; repairAction: RelayDriftRepairAction }>
    | Readonly<{ status: 'daemon_not_running'; repairAction: RelayDriftRepairAction }>
    | Readonly<{ status: 'daemon_url_mismatch'; repairAction: RelayDriftRepairAction }>
    | Readonly<{ status: 'daemon_needs_auth'; repairAction: RelayDriftRepairAction }>
    /**
     * The daemon is healthy on this relay but signed in to a different account than the app. It is
     * authenticated, so "needs to sign in" would be untrue, and "aligned" would let every surface
     * count someone else's machine as this user's computer.
     */
    | Readonly<{ status: 'daemon_account_mismatch'; repairAction: RelayDriftRepairAction }>;

export type RelayDriftStatus = RelayDriftClassification['status'];

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

/**
 * Whether a daemon serves the app's relay (or its known local equivalent). `null` when either side
 * is unknown: no active relay to compare, or a daemon that reports no relay at all.
 */
export function isDaemonOnActiveRelay(params: Readonly<{
    activeRelayUrl: string | null | undefined;
    activeLocalRelayUrl?: string | null | undefined;
    daemonRelayUrl: string | null | undefined;
    daemonAlternateRelayUrls?: readonly (string | null | undefined)[];
}>): boolean | null {
    const activeRelayKey = createRelayUrlComparableKeySafe(params.activeRelayUrl);
    if (!activeRelayKey) {
        return null;
    }
    const acceptedRelayKeys = new Set<string>([activeRelayKey]);
    const activeLocalRelayKey = createRelayUrlComparableKeySafe(params.activeLocalRelayUrl);
    if (activeLocalRelayKey) {
        acceptedRelayKeys.add(activeLocalRelayKey);
    }

    const daemonRelayKeys = new Set<string>();
    for (const candidate of [params.daemonRelayUrl, ...(params.daemonAlternateRelayUrls ?? [])]) {
        const candidateKey = createRelayUrlComparableKeySafe(candidate);
        if (candidateKey) {
            daemonRelayKeys.add(candidateKey);
        }
    }
    if (daemonRelayKeys.size === 0) {
        return null;
    }
    return [...daemonRelayKeys].some((daemonRelayKey) => acceptedRelayKeys.has(daemonRelayKey));
}

/**
 * Whether a daemon is signed in to an account other than the app's. Only a known account on both
 * sides can differ: a daemon without credentials needs to sign in, and an app without an account
 * (signed out, or a source that does not describe this computer) has nothing to contradict.
 */
export function isDaemonOfAnotherAccount(params: Readonly<{
    daemonAccountId: string | null | undefined;
    appAccountId: string | null | undefined;
}>): boolean {
    const daemonAccountId = String(params.daemonAccountId ?? '').trim();
    const appAccountId = String(params.appAccountId ?? '').trim();
    return Boolean(daemonAccountId && appAccountId && daemonAccountId !== appAccountId);
}

export function classifyRelayDrift(params: Readonly<{
    activeRelayUrl: string | null | undefined;
    activeLocalRelayUrl?: string | null | undefined;
    daemonRelayUrl: string | null | undefined;
    daemonAlternateRelayUrls?: readonly (string | null | undefined)[];
    daemonAccountId: string | null | undefined;
    /**
     * The account the APP is signed in to on this relay. `null`/absent means the app has no account
     * to compare (signed out, or a source that does not describe this computer), and nothing the
     * daemon reports can contradict it.
     */
    appAccountId?: string | null | undefined;
    daemonNeedsAuth?: boolean | null | undefined;
    daemonServiceInstalled?: boolean | null | undefined;
    daemonRunning?: boolean | null | undefined;
}>): RelayDriftClassification {
    if (!createRelayUrlComparableKeySafe(params.activeRelayUrl)) {
        return { status: 'aligned', repairAction: null };
    }

    const onActiveRelay = isDaemonOnActiveRelay(params);
    if (onActiveRelay === null) {
        return {
            status: 'daemon_not_configured',
            repairAction: { kind: 'connectBackgroundServiceToActiveRelay' },
        };
    }

    if (!onActiveRelay) {
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

    if (isDaemonOfAnotherAccount({ daemonAccountId: params.daemonAccountId, appAccountId: params.appAccountId })) {
        return {
            status: 'daemon_account_mismatch',
            repairAction: { kind: 'connectBackgroundServiceToActiveRelay' },
        };
    }

    return { status: 'aligned', repairAction: null };
}

/** A background service's state as every "this computer" list shows it (R16 c). */
export type ThisComputerServiceState = 'connected' | 'offline' | 'needs_attention';

/**
 * The one mapping from a service's drift to the state every "this computer" list shows: the
 * executor's rows and the app's re-judgement of its own Home both use it (N-16).
 */
export function resolveThisComputerServiceState(status: RelayDriftStatus): ThisComputerServiceState {
    switch (status) {
        case 'aligned':
            return 'connected';
        case 'daemon_not_running':
        case 'daemon_not_installed':
            return 'offline';
        default:
            return 'needs_attention';
    }
}
