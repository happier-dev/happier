import * as React from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import type { TriageConfigureSourceOfferV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageSessionPullRequestBindingV1 } from '../sessionPullRequestStatus.js';
import { openTriagePullRequestLocalFormV1 } from '../sessionPullRequestControls.js';

export type PullRequestLocalOpenStateV1 = 'idle' | 'opening' | 'unavailable';

/**
 * Where the glance's two ways out lead, through the host's own owners: the latest update opens where it
 * happened (the retained Session input through `revealSessionInput`, or the provider page), and "Run the job
 * locally" opens the admitted source's local-run form for this Session's accepted checkout. Opening never
 * runs a process, grants fixing rounds or reads the provider.
 */
export function usePullRequestGlanceNavigationV1(session: Readonly<{ serverId: string; sessionId: string }> | null, signal: AbortSignal) {
    const host = usePluginHostApi();
    const [localOpen, setLocalOpen] = React.useState<PullRequestLocalOpenStateV1>('idle');
    const latestOpener = React.useCallback((binding: TriageSessionPullRequestBindingV1): (() => void) | null => {
        const location = binding.latestUpdate?.location;
        if (location === undefined) return null;
        if (location.kind === 'provider') return () => {
            void (location.resource === undefined ? host.openExternalLink(location.url, { signal }) : host.openResource(location.resource, { signal })).catch(() => undefined);
        };
        if (session === null) return null;
        return () => { void host.revealSessionInput({ sessionId: session.sessionId, localId: location.localId }, { signal }).catch(() => undefined); };
    }, [host, session, signal]);
    const runLocally = React.useCallback(async (binding: TriageSessionPullRequestBindingV1) => {
        if (session === null) return;
        setLocalOpen('opening');
        try {
            const sha = binding.watch.progress?.sourceHeadSha;
            const result = await openTriagePullRequestLocalFormV1(host, { session, binding,
                ...(sha === undefined ? {} : { cause: { sourceHeadSha: sha } }),
            }, { signal });
            if (!signal.aborted) setLocalOpen(result.kind === 'unavailable' ? 'unavailable' : 'idle');
        } catch {
            if (!signal.aborted) setLocalOpen('unavailable');
        }
    }, [host, session, signal]);
    return React.useMemo(() => ({ latestOpener, runLocally, localOpen }), [latestOpener, localOpen, runLocally]);
}

/**
 * Recovery for unavailable native PR status: the admitted source's own
 * Settings page, opened as the sources screen opens it (no launch input, no sub-path). The page owns the
 * repository selection and its save, so nothing is written from here. `open` is null when this mount cannot
 * navigate, so the control is not drawn dead; `refused` names the source whose page the host would not open.
 */
export function useConfigureSourceRecoveryV1() {
    const host = usePluginHostApi();
    const [refused, setRefused] = React.useState<string | null>(null);
    const canOpen = host.version().methods.includes('openSurface');
    const open = React.useCallback(async (offer: TriageConfigureSourceOfferV1) => {
        setRefused(null);
        try {
            await host.openSurface(offer.destination);
        } catch {
            setRefused(offer.displayName);
        }
    }, [host]);
    return React.useMemo(() => ({ open: canOpen ? open : null, refused }), [canOpen, open, refused]);
}
