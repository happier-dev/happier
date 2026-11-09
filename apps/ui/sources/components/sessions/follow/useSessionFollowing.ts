import * as React from 'react';

import { listSessionFollowSources } from '@/sync/api/session/sessionFollowSourcesApi';
import type { SessionFollowRulesReadResult } from '@/sync/api/session/sessionFollowRulesApi';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

import { isAccountFollowConfigurationChangeRelevant, isSessionFollowAccountChangeRelevant } from './sessionFollowAccountChange';
import { useSessionFollowRules, type SessionFollowRulesController } from './useSessionFollowRules';

type FollowingResult = Awaited<ReturnType<typeof listSessionFollowSources>>;
export type SessionFollowingProjection = Extract<FollowingResult, { kind: 'ok' }>['value'];
export type SessionFollowingController = Readonly<{
    projection: SessionFollowingProjection | null;
    loading: boolean;
    error: string | null;
    ruleInputs: SessionFollowRulesController;
    refresh(): Promise<void>;
}>;
type FollowingState = Readonly<{
    key: string;
    lifetime: ServerAccountScopeLifetime | null;
    projection: SessionFollowingProjection | null;
    loading: boolean;
    error: string | null;
}>;
type ReadFlight = {
    key: string;
    controller: AbortController;
    dirty: boolean;
    running: boolean;
    rules: SessionFollowRulesReadResult;
    settled: Promise<void>;
};

/** One Following census, including opened private rules, shared by pane and directional sheet. */
export function useSessionFollowing(address: SessionAddress | null, enabled: boolean): SessionFollowingController {
    const serverId = address?.serverId;
    const sessionId = address?.sessionId;
    const rules = useSessionFollowRules(serverId ?? null, enabled && Boolean(sessionId));
    const { accountId } = rules;
    const lifetime = rules.lifetime ?? null;
    const key = JSON.stringify([serverId, sessionId, accountId]);
    const [state, setState] = React.useState<FollowingState>({ key: '', lifetime: null, projection: null, loading: false, error: null });
    const readFlightRef = React.useRef<ReadFlight | null>(null);
    const sourceIdsRef = React.useRef<ReadonlySet<string>>(new Set());

    const read = React.useCallback((snapshot: SessionFollowRulesReadResult, force = false): Promise<void> => {
        if (!enabled || !serverId || !sessionId || !lifetime?.isCurrent()) return Promise.resolve();
        const running = readFlightRef.current;
        if (running?.key === key && !running.controller.signal.aborted) {
            if (!force && running.rules === snapshot) return running.settled;
            if (running.running) {
                running.dirty = true;
                running.rules = snapshot;
                return running.settled;
            }
        }
        const flight: ReadFlight = { key, controller: new AbortController(), dirty: false, running: true, rules: snapshot, settled: Promise.resolve() };
        const isCurrent = () => !flight.controller.signal.aborted && lifetime.isCurrent();
        flight.settled = (async () => {
            try {
                do {
                    flight.dirty = false;
                    setState(current => ({ key, lifetime,
                        projection: current.key === key && current.lifetime === lifetime ? current.projection : null, loading: true, error: null }));
                    const ruleSnapshot = flight.rules;
                    const result = await listSessionFollowSources({ serverId, sessionId }, flight.controller.signal, accountId, { rules: ruleSnapshot })
                        .catch(() => ({ kind: 'failed', error: 'unavailable' } as const));
                    if (!isCurrent()) return;
                    if (result.kind === 'ok') {
                        sourceIdsRef.current = new Set(result.value.sources.flatMap(source => (
                            'sourceSessionId' in source ? [source.sourceSessionId] : []
                        )));
                        setState({ key, lifetime, projection: result.value, loading: false, error: null });
                    } else {
                        setState(current => ({ key, lifetime,
                            projection: result.error === 'unavailable' && current.key === key && current.lifetime === lifetime ? current.projection : null,
                            loading: false, error: result.error }));
                    }
                } while (flight.dirty && isCurrent());
            } finally {
                // A manual refresh and the snapshot effect consume the same acquisition.
                // Keep its settled identity until a fresh census or source fact arrives.
                flight.running = false;
            }
        })();
        readFlightRef.current = flight;
        return flight.settled;
    }, [accountId, enabled, key, lifetime, serverId, sessionId]);
    const refreshRules = rules.refresh;
    const refresh = React.useCallback(async () => {
        const snapshot = await refreshRules();
        if (snapshot) await read(snapshot);
    }, [read, refreshRules]);

    React.useEffect(() => {
        sourceIdsRef.current = new Set();
        const retirement = lifetime?.onRetire(() => {
            if (readFlightRef.current?.key === key) readFlightRef.current.controller.abort();
            setState({ key, lifetime, projection: null, loading: false, error: 'action_account_scope_changed' });
        });
        return () => {
            if (readFlightRef.current?.key === key) readFlightRef.current.controller.abort();
            retirement?.dispose();
        };
    }, [key, lifetime]);

    React.useEffect(() => {
        if (rules.snapshot) void read(rules.snapshot);
    }, [read, rules.snapshot]);

    React.useEffect(() => {
        if (!enabled || !lifetime?.isCurrent() || !serverId || !sessionId) return;
        return subscribeHomeAccountChange(event => {
            if (!lifetime.isCurrent() || !areServerProfileIdentifiersEquivalent(event.serverId, serverId)) return;
            // Configuration changes publish through the single private census;
            // only source facts demand another Following projection here.
            if (isAccountFollowConfigurationChangeRelevant(event)
                || !isSessionFollowAccountChangeRelevant(event, new Set([sessionId, ...sourceIdsRef.current]))) return;
            if (rules.snapshot) void read(rules.snapshot, true);
        });
    }, [enabled, lifetime, read, rules.snapshot, serverId, sessionId]);

    const visible = enabled && lifetime?.isCurrent() && state.key === key && state.lifetime === lifetime ? state : null;
    const loading = rules.loading || enabled && Boolean(address) && Boolean(lifetime?.isCurrent() && (!visible || visible.loading));
    return {
        projection: visible?.projection ?? null,
        loading,
        error: visible?.error ?? (enabled && address && !rules.loading && !lifetime ? 'unavailable' : null),
        ruleInputs: rules,
        refresh,
    };
}
