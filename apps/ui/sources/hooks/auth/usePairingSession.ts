import * as React from 'react';

import { createPairingSecret } from '@/auth/pairing/pairingSecret';
import { buildPairingDeepLink } from '@/auth/pairing/pairingUrl';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getCachedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolvePreferredShareableServerUrl } from '@/sync/domains/server/url/shareableServerUrl';
import { isRuntimeActive } from '@/utils/runtime/isRuntimeActive';
import {
    pairingStart,
    pairingStatus,
    type PairingStatus,
} from '@/sync/api/account/apiPairingAuth';

const PAIRING_STATUS_POLL_INTERVAL_MS = 1_000;

type StartPairingResult = { ok: true } | { ok: false; status: number };

/**
 * Desktop/web pairing session lifecycle:
 * - start: generate secret + POST /v1/auth/pairing/start
 * - poll: GET /v1/auth/pairing/status until phone requests
 * - approve: handled by caller via existing auth account link flow
 */
export function usePairingSession(params: Readonly<{ enabled: boolean; isAuthenticated: boolean }>): Readonly<{
    deepLink: string | null;
    status: PairingStatus | null;
    isExpired: boolean;
    isStarting: boolean;
    startPairing: () => Promise<StartPairingResult>;
    clearSession: () => void;
}> {
    const enabled = params.enabled;
    const isAuthenticated = params.isAuthenticated;

    const [pairId, setPairId] = React.useState<string | null>(null);
    const [status, setStatus] = React.useState<PairingStatus | null>(null);
    const [deepLink, setDeepLink] = React.useState<string | null>(null);
    const [isExpired, setIsExpired] = React.useState(false);
    const [isStarting, setIsStarting] = React.useState(false);
    const isStartingRef = React.useRef(false);

    const clearSession = React.useCallback(() => {
        setPairId(null);
        setStatus(null);
        setDeepLink(null);
        setIsExpired(false);
    }, []);

    React.useEffect(() => {
        if (enabled && isAuthenticated) return;
        clearSession();
    }, [clearSession, enabled, isAuthenticated]);

    const startPairing = React.useCallback(async () => {
        if (!enabled || !isAuthenticated) {
            return { ok: false, status: 401 } as const;
        }
        if (isStartingRef.current) {
            return { ok: false, status: 409 } as const;
        }

        isStartingRef.current = true;
        setIsStarting(true);
        setIsExpired(false);
        setStatus(null);
        setDeepLink(null);
        setPairId(null);

        try {
            const { secret, secretHash } = await createPairingSecret();
            const started = await pairingStart({ secretHash });
            if (!started.ok) {
                return { ok: false, status: started.status } as const;
            }

            const data = started.data;
            const active = getActiveServerSnapshot();
            const cached = getCachedServerFeaturesSnapshot({ serverId: active.serverId });
            const canonicalRaw =
                cached?.status === 'ready'
                    ? cached.features.capabilities?.server?.canonicalServerUrl
                    : null;
            const canonical = typeof canonicalRaw === 'string' ? canonicalRaw.trim() : '';
            const serverUrl = resolvePreferredShareableServerUrl({
                preferredShareableServerUrl: active.activeShareableServerUrl,
                canonicalServerUrl: canonical || null,
                activeServerUrl: active.serverUrl,
            });

            const link = buildPairingDeepLink({ pairId: data.pairId, secret, serverUrl });

            setPairId(data.pairId);
            setDeepLink(link);
            setStatus({ state: 'pending', pairId: data.pairId, expiresAt: data.expiresAt });
            return { ok: true } as const;
        } catch {
            return { ok: false, status: 500 } as const;
        } finally {
            setIsStarting(false);
            isStartingRef.current = false;
        }
    }, [enabled, isAuthenticated]);

    React.useEffect(() => {
        if (!enabled || !isAuthenticated) return;
        if (!pairId) return;
        let cancelled = false;

        const poll = async () => {
            if (!isRuntimeActive()) {
                return;
            }
            try {
                const res = await pairingStatus({ pairId });
                if (!res.ok) {
                    if (res.reason === 'not_found') {
                        if (!cancelled) {
                            setIsExpired(true);
                            setStatus(null);
                            setDeepLink(null);
                            setPairId(null);
                        }
                    }
                    return;
                }
                if (!cancelled) {
                    setIsExpired(false);
                    setStatus(res.data);
                }
            } catch {
                // ignore
            }
        };

        const interval = setInterval(() => {
            void poll();
        }, PAIRING_STATUS_POLL_INTERVAL_MS);
        void poll();

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [enabled, isAuthenticated, pairId]);

    return { deepLink, status, isExpired, isStarting, startPairing, clearSession };
}
