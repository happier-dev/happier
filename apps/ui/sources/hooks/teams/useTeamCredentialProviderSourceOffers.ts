import * as React from 'react';
import type {
    DaemonProviderConnectionViewV1,
    DaemonProviderConnectionsDescribeResponseV1,
} from '@happier-dev/protocol/rpc';

import { describeProviderConnections, providerErrorFromRpcFailure } from '@/providers/actions/client';
import type { ProviderSettingsMachineRowV1 } from '@/providers/hooks/targetMachine';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

type ProviderConnectionsError = Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'error' }>['error'];

/**
 * One Provider Connection this Account may offer a Team, and the computer whose
 * daemon can actually serve it.
 *
 * Provider Connections are Account-scoped, but whether one is *offerable* is a
 * per-computer fact: the daemon only publishes the witness once the credential
 * slot resolves and the endpoint is reachable there. The machine is carried so
 * the model catalog of a chosen source is read from a computer that has it,
 * rather than from whichever computer Provider Settings happens to be pointed
 * at.
 */
export type TeamCredentialProviderSourceOfferV1 =
    NonNullable<DaemonProviderConnectionViewV1['teamCredentialSourceOffer']>
    & Readonly<{ machineId: string; serverId: string | null; machineDisplayName: string | null }>;

export type TeamCredentialProviderSourceOffersProjection = Readonly<{
    offers: readonly TeamCredentialProviderSourceOfferV1[];
    loading: boolean;
    /** The first refusal, kept beside whatever the other computers did answer. */
    error: ProviderConnectionsError | null;
    refresh: () => Promise<readonly TeamCredentialProviderSourceOfferV1[] | null>;
}>;

const NO_OFFERS: readonly TeamCredentialProviderSourceOfferV1[] = Object.freeze([]);

type OffersState = Readonly<{
    scopeKey: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    offers: readonly TeamCredentialProviderSourceOfferV1[];
    error: ProviderConnectionsError | null;
    loading: boolean;
}>;

function machineScopeKey(machines: readonly ProviderSettingsMachineRowV1[]): string {
    return JSON.stringify(machines
        .map((row) => [row.target.serverIdentityId, row.serverId, row.target.machineId] as const)
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function offerRouteKey(offer: TeamCredentialProviderSourceOfferV1): string {
    return JSON.stringify([
        offer.serverId,
        offer.machineId,
        offer.connectionId,
        offer.credentialSlotId,
        offer.connectionSecurityFingerprint,
    ]);
}

function machineRouteKey(input: Readonly<{ serverId: string | null; machineId: string }>): string {
    return JSON.stringify([input.serverId, input.machineId]);
}

/**
 * Every Provider Connection the creator may currently offer, across the
 * computers this Account administers under one server identity.
 *
 * Asking only the selected Provider Settings target would make a connection
 * whose credential lives on another computer unreachable from Team Settings —
 * a person would have to change a global preference to finish an unrelated
 * flow. A source binding may be identical on two computers, but the offer is
 * not: each exact daemon route stays available so later reads cannot bind the
 * wrong Machine incarnation.
 */
export function useTeamCredentialProviderSourceOffers(input: Readonly<{
    enabled: boolean;
    machines: readonly ProviderSettingsMachineRowV1[];
}>): TeamCredentialProviderSourceOffersProjection {
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const { enabled, machines } = input;
    const scopeKey = JSON.stringify([enabled, machineScopeKey(machines)]);
    const [state, setState] = React.useState<OffersState>({
        scopeKey: null,
        accountLifetime: null,
        offers: NO_OFFERS,
        error: null,
        loading: false,
    });
    const generation = React.useRef(0);
    const currentAccountLifetimeRef = React.useRef(accountLifetime);
    currentAccountLifetimeRef.current = accountLifetime;
    // The rows themselves rebuild on every machine heartbeat; only their
    // identity may restart a read in flight.
    const machinesRef = React.useRef(machines);
    machinesRef.current = machines;

    const stateMatchesScope = state.scopeKey === scopeKey && state.accountLifetime === accountLifetime;
    const active = enabled && machines.length > 0;

    React.useEffect(() => {
        const registration = accountLifetime?.onRetire(() => {
            if (currentAccountLifetimeRef.current !== accountLifetime) return;
            generation.current += 1;
            setState((current) => current.accountLifetime === accountLifetime
                ? { scopeKey: null, accountLifetime: null, offers: NO_OFFERS, error: null, loading: false }
                : current);
        });
        return () => registration?.dispose();
    }, [accountLifetime]);

    const refresh = React.useCallback(async () => {
        const requestGeneration = ++generation.current;
        const requestStillCurrent = (): boolean => (
            currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)
            && requestGeneration === generation.current
        );
        if (!requestStillCurrent()) return null;
        if (!enabled || machinesRef.current.length === 0) {
            setState({ scopeKey, accountLifetime, offers: NO_OFFERS, error: null, loading: false });
            return NO_OFFERS;
        }
        setState((current) => current.scopeKey === scopeKey && current.accountLifetime === accountLifetime
            ? { ...current, loading: true }
            : { scopeKey, accountLifetime, offers: NO_OFFERS, error: null, loading: true });

        const targets = machinesRef.current;
        const answers = await Promise.all(targets.map(async (row) => {
            try {
                const response = await describeProviderConnections({
                    machineId: row.target.machineId,
                    serverId: row.serverId,
                });
                return { row, response } as const;
            } catch (caught) {
                return {
                    row,
                    response: {
                        status: 'error',
                        error: providerErrorFromRpcFailure(caught, { machineId: row.target.machineId }),
                    },
                } as const;
            }
        }));
        if (!requestStillCurrent()) return null;

        const freshOffers: TeamCredentialProviderSourceOfferV1[] = [];
        const successfulMachines = new Set<string>();
        let error: ProviderConnectionsError | null = null;
        for (const { row, response } of answers) {
            if (response.status !== 'success') {
                error = error ?? response.error;
                continue;
            }
            successfulMachines.add(machineRouteKey({ serverId: row.serverId, machineId: row.target.machineId }));
            for (const connection of response.connections) {
                const offer = connection.teamCredentialSourceOffer;
                if (!offer) continue;
                freshOffers.push(Object.freeze({
                    ...offer,
                    machineId: row.target.machineId,
                    serverId: row.serverId,
                    machineDisplayName: row.displayName?.trim() || null,
                }));
            }
        }
        if (successfulMachines.size === 0) {
            setState((current) => ({
                scopeKey,
                accountLifetime,
                offers: current.scopeKey === scopeKey && current.accountLifetime === accountLifetime
                    ? current.offers
                    : NO_OFFERS,
                error,
                loading: false,
            }));
            return null;
        }

        const freshSeen = new Set<string>();
        const distinctFreshOffers = freshOffers.filter((offer) => {
            const key = offerRouteKey(offer);
            if (freshSeen.has(key)) return false;
            freshSeen.add(key);
            return true;
        });
        setState((current) => {
            const retained = current.scopeKey === scopeKey && current.accountLifetime === accountLifetime
                ? current.offers.filter((offer) => !successfulMachines.has(machineRouteKey(offer)))
                : NO_OFFERS;
            const seen = new Set(distinctFreshOffers.map(offerRouteKey));
            const resolved = [...distinctFreshOffers, ...retained.filter((offer) => {
                const key = offerRouteKey(offer);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })];
            return {
                scopeKey,
                accountLifetime,
                offers: resolved.length === 0 ? NO_OFFERS : Object.freeze(resolved),
                error,
                loading: false,
            };
        });
        return distinctFreshOffers.length === 0 ? NO_OFFERS : Object.freeze(distinctFreshOffers);
    }, [accountLifetime, enabled, scopeKey]);

    React.useEffect(() => {
        void refresh();
        return () => { generation.current += 1; };
    }, [refresh]);

    return React.useMemo(() => Object.freeze({
        offers: stateMatchesScope ? state.offers : NO_OFFERS,
        // A scope that has not answered yet is loading, not empty: an empty
        // chooser would tell the creator they have nothing to offer.
        loading: active && (!stateMatchesScope || state.loading),
        error: stateMatchesScope ? state.error : null,
        refresh,
    }), [active, refresh, state.error, state.loading, state.offers, stateMatchesScope]);
}
