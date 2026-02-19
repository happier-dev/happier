import * as React from 'react';
import {
    applyFeatureDependencies,
    createFeatureDecision,
    evaluateFeatureDecisionBase,
    featureRequiresServerSnapshot,
    getFeatureDependencies,
    isFeatureServerRepresented,
    readServerEnabledBit,
    type FeatureDecision,
    type FeatureDecisionScope,
    type FeatureId,
} from '@happier-dev/protocol';
import type { Settings } from '@/sync/domains/settings/settings';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    getCachedServerFeaturesSnapshot,
    getServerFeaturesSnapshot,
    type ServerFeaturesSnapshot,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { getFeatureBuildPolicyDecision } from './featureBuildPolicy';
import { resolveLocalFeaturePolicyEnabled } from './featureLocalPolicy';

const evaluateFeatureDecision = evaluateFeatureDecisionBase;

export type ServerFeaturesRuntimeSnapshot =
    | Readonly<{ status: 'loading' }>
    | ServerFeaturesSnapshot;

export type ServerFeaturesMainSelectionSnapshot =
    | Readonly<{ status: 'loading'; serverIds: string[]; snapshotsByServerId: Record<string, ServerFeaturesSnapshot> }>
    | Readonly<{ status: 'ready'; serverIds: string[]; snapshotsByServerId: Record<string, ServerFeaturesSnapshot> }>;

export function useServerFeaturesRuntimeSnapshot(options?: Readonly<{ enabled?: boolean }>): ServerFeaturesRuntimeSnapshot {
    const enabled = options?.enabled ?? true;
    const [snapshot, setSnapshot] = React.useState<ServerFeaturesRuntimeSnapshot>(() => {
        if (!enabled) return { status: 'loading' };
        const cached = getCachedServerFeaturesSnapshot();
        return cached ?? { status: 'loading' };
    });

    React.useEffect(() => {
        if (!enabled) {
            setSnapshot({ status: 'loading' });
            return;
        }

        let cancelled = false;
        let requestToken = 0;

        const loadForServerId = async (serverId: string | undefined) => {
            const token = requestToken + 1;
            requestToken = token;
            const next = await getServerFeaturesSnapshot({
                serverId,
            });
            if (!cancelled && token === requestToken) {
                setSnapshot(next);
            }
        };

        const unsubscribe = subscribeActiveServer((active) => {
            const serverId = typeof (active as any)?.serverId === 'string' ? String((active as any).serverId).trim() : '';
            if (!serverId) return;

            const cached = getCachedServerFeaturesSnapshot({ serverId });
            setSnapshot(cached ?? { status: 'loading' });
            fireAndForget(loadForServerId(serverId), { tag: 'useServerFeaturesSnapshot.subscribeActiveServer' });
        });

        fireAndForget((async () => {
            const cached = getCachedServerFeaturesSnapshot();
            if (cached && !cancelled) setSnapshot(cached);
            await loadForServerId(undefined);
        })(), { tag: 'useServerFeaturesSnapshot.initialLoad' });

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [enabled]);

    return snapshot;
}

export function useServerFeaturesSnapshotForServerId(
    serverIdRaw: string | null | undefined,
    options?: Readonly<{ enabled?: boolean }>,
): ServerFeaturesRuntimeSnapshot {
    const enabled = options?.enabled ?? true;
    const serverId = normalizeId(serverIdRaw);
    const [snapshot, setSnapshot] = React.useState<ServerFeaturesRuntimeSnapshot>(() => {
        if (!enabled) return { status: 'loading' };
        if (!serverId) return { status: 'loading' };
        const cached = getCachedServerFeaturesSnapshot({ serverId });
        return cached ?? { status: 'loading' };
    });

    React.useEffect(() => {
        if (!enabled) {
            setSnapshot({ status: 'loading' });
            return () => undefined;
        }

        let cancelled = false;
        let requestToken = 0;

        const load = async (serverId: string) => {
            const token = requestToken + 1;
            requestToken = token;
            const next = await getServerFeaturesSnapshot({ serverId });
            if (!cancelled && token === requestToken) {
                setSnapshot(next);
            }
        };

        if (!serverId) {
            setSnapshot({ status: 'loading' });
            return () => {
                cancelled = true;
            };
        }

        const cached = getCachedServerFeaturesSnapshot({ serverId });
        setSnapshot(cached ?? { status: 'loading' });
        fireAndForget(load(serverId), { tag: 'useServerFeaturesSnapshotForServerId.initialLoad' });

        return () => {
            cancelled = true;
        };
    }, [enabled, serverId]);

    return snapshot;
}

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function normalizeServerIds(raw: ReadonlyArray<string>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const idRaw of raw) {
        const id = normalizeId(idRaw);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

export function useServerFeaturesMainSelectionSnapshot(
    serverIdsRaw: ReadonlyArray<string>,
    options?: Readonly<{ enabled?: boolean }>,
): ServerFeaturesMainSelectionSnapshot {
    const enabled = options?.enabled ?? true;
    const serverIds = React.useMemo(() => normalizeServerIds(serverIdsRaw), [serverIdsRaw]);

    const [state, setState] = React.useState<ServerFeaturesMainSelectionSnapshot>(() => {
        if (!enabled) {
            return { status: 'ready', serverIds, snapshotsByServerId: {} };
        }
        if (serverIds.length === 0) {
            return { status: 'ready', serverIds, snapshotsByServerId: {} };
        }

        const snapshotsByServerId: Record<string, ServerFeaturesSnapshot> = {};
        const missing: string[] = [];
        for (const serverId of serverIds) {
            const cached = getCachedServerFeaturesSnapshot({ serverId });
            if (cached) snapshotsByServerId[serverId] = cached;
            else missing.push(serverId);
        }

        if (missing.length === 0) {
            return { status: 'ready', serverIds, snapshotsByServerId };
        }
        return { status: 'loading', serverIds, snapshotsByServerId };
    });

    React.useEffect(() => {
        let cancelled = false;
        let requestToken = 0;

        if (!enabled) {
            setState({ status: 'ready', serverIds, snapshotsByServerId: {} });
            return () => {
                cancelled = true;
            };
        }

        if (serverIds.length === 0) {
            setState({ status: 'ready', serverIds, snapshotsByServerId: {} });
            return () => {
                cancelled = true;
            };
        }

        const load = async (serverIds: string[]) => {
            const token = requestToken + 1;
            requestToken = token;

            const results = await Promise.all(
                serverIds.map(async (serverId) => [serverId, await getServerFeaturesSnapshot({ serverId })] as const),
            );

            if (cancelled || token !== requestToken) return;

            const snapshotsByServerId: Record<string, ServerFeaturesSnapshot> = {};
            for (const [id, snapshot] of results) {
                snapshotsByServerId[id] = snapshot;
            }
            setState({ status: 'ready', serverIds, snapshotsByServerId });
        };

        // Recompute state from cache on any selection change.
        const snapshotsByServerId: Record<string, ServerFeaturesSnapshot> = {};
        const missing: string[] = [];
        for (const serverId of serverIds) {
            const cached = getCachedServerFeaturesSnapshot({ serverId });
            if (cached) snapshotsByServerId[serverId] = cached;
            else missing.push(serverId);
        }

        if (missing.length === 0) {
            setState({ status: 'ready', serverIds, snapshotsByServerId });
            return () => {
                cancelled = true;
            };
        }

        setState({ status: 'loading', serverIds, snapshotsByServerId });
        fireAndForget(load(serverIds), { tag: 'useServerFeaturesMainSelectionSnapshot.initialLoad' });

        return () => {
            cancelled = true;
        };
    }, [enabled, serverIds]);

    return state;
}

export function resolveRuntimeFeatureDecisionFromSnapshot(params: {
    featureId: FeatureId;
    settings: Settings;
    snapshot: ServerFeaturesRuntimeSnapshot;
    scope?: FeatureDecisionScope;
}): FeatureDecision | null {
    const scope: FeatureDecisionScope = params.scope ?? { scopeKind: 'runtime' };

    const memo = new Map<FeatureId, FeatureDecision | null>();

    const resolveBaseDecision = (featureId: FeatureId): FeatureDecision | null => {
        const buildPolicy = getFeatureBuildPolicyDecision(featureId);
        const localPolicyEnabled = resolveLocalFeaturePolicyEnabled(featureId, params.settings);

        // Global policy gates apply before any server probing.
        const global = evaluateFeatureDecision({
            featureId,
            scope,
            supportsClient: true,
            buildPolicy,
            localPolicyEnabled,
            serverSupported: true,
            serverEnabled: true,
        });
        if (global.blockedBy && global.blockedBy !== 'server') {
            return global;
        }

        if (!isFeatureServerRepresented(featureId)) {
            return global;
        }

        if (params.snapshot.status === 'loading') {
            return null;
        }

        if (params.snapshot.status === 'error') {
            return createFeatureDecision({
                featureId,
                state: 'unknown',
                blockedBy: 'server',
                blockerCode: 'probe_failed',
                diagnostics: [`server_error:${params.snapshot.reason}`],
                evaluatedAt: Date.now(),
                scope,
            });
        }

        if (params.snapshot.status === 'unsupported') {
            return createFeatureDecision({
                featureId,
                state: 'unsupported',
                blockedBy: 'server',
                blockerCode: params.snapshot.reason === 'endpoint_missing' ? 'endpoint_missing' : 'misconfigured',
                diagnostics: [`server_unsupported:${params.snapshot.reason}`],
                evaluatedAt: Date.now(),
                scope,
            });
        }

        const serverEnabled = readServerEnabledBit(params.snapshot.features, featureId) === true;
        return evaluateFeatureDecision({
            featureId,
            scope,
            supportsClient: true,
            buildPolicy,
            localPolicyEnabled,
            serverSupported: true,
            serverEnabled,
        });
    };

    const resolveDecision = (featureId: FeatureId): FeatureDecision | null => {
        const cached = memo.get(featureId);
        if (cached !== undefined) return cached;

        const base = resolveBaseDecision(featureId);
        if (!base) {
            memo.set(featureId, null);
            return null;
        }

        if (base.state !== 'enabled') {
            memo.set(featureId, base);
            return base;
        }

        const dependencies = getFeatureDependencies(featureId);
        for (const depId of dependencies) {
            const depDecision = resolveDecision(depId);
            if (!depDecision) {
                memo.set(featureId, null);
                return null;
            }
        }

        const withDependencies = applyFeatureDependencies({
            featureId,
            baseDecision: base,
            resolveDependencyDecision: (depId) => {
                const resolved = resolveDecision(depId);
                if (resolved) return resolved;
                return createFeatureDecision({
                    featureId: depId,
                    state: 'unknown',
                    blockedBy: 'server',
                    blockerCode: 'probe_failed',
                    diagnostics: ['dependency_unresolved'],
                    evaluatedAt: base.evaluatedAt,
                    scope,
                });
            },
        });

        memo.set(featureId, withDependencies);
        return withDependencies;
    };

    // Shortcut: if neither this feature nor its dependency closure needs server probes, do not defer on loading snapshots.
    if (params.snapshot.status === 'loading' && featureRequiresServerSnapshot(params.featureId) !== true) {
        return resolveDecision(params.featureId);
    }

    return resolveDecision(params.featureId);
}

export function resolveMainSelectionFeatureDecision(params: {
    featureId: FeatureId;
    settings: Settings;
    snapshot: ServerFeaturesMainSelectionSnapshot;
}): FeatureDecision | null {
    const scope: FeatureDecisionScope = { scopeKind: 'main_selection' };

    const buildPolicy = getFeatureBuildPolicyDecision(params.featureId);
    const localPolicyEnabled = resolveLocalFeaturePolicyEnabled(params.featureId, params.settings);

    // Global policy gates apply before any server probing/aggregation.
    const global = evaluateFeatureDecision({
        featureId: params.featureId,
        scope,
        supportsClient: true,
        buildPolicy,
        localPolicyEnabled,
        serverSupported: true,
        serverEnabled: true,
    });
    if (global.blockedBy && global.blockedBy !== 'server') {
        return global;
    }

    const requiresServerSnapshot = featureRequiresServerSnapshot(params.featureId);

    if (!requiresServerSnapshot) {
        const memo = new Map<FeatureId, FeatureDecision>();

        const resolveDecision = (featureId: FeatureId): FeatureDecision => {
            const cached = memo.get(featureId);
            if (cached) return cached;

            const buildPolicy = getFeatureBuildPolicyDecision(featureId);
            const localPolicyEnabled = resolveLocalFeaturePolicyEnabled(featureId, params.settings);
            const base = evaluateFeatureDecision({
                featureId,
                scope,
                supportsClient: true,
                buildPolicy,
                localPolicyEnabled,
                serverSupported: true,
                serverEnabled: true,
            });

            if (base.state !== 'enabled') {
                memo.set(featureId, base);
                return base;
            }

            const withDependencies = applyFeatureDependencies({
                featureId,
                baseDecision: base,
                resolveDependencyDecision: resolveDecision,
            });
            memo.set(featureId, withDependencies);
            return withDependencies;
        };

        return resolveDecision(params.featureId);
    }

    if (params.snapshot.status === 'loading') {
        return null;
    }

    const serverIds = params.snapshot.serverIds;
    const snapshots = params.snapshot.snapshotsByServerId;

    const resolveDecisionForServerFeatures = (serverFeatures: (typeof params.snapshot.snapshotsByServerId)[string] & { status: 'ready' }): FeatureDecision => {
        const memo = new Map<FeatureId, FeatureDecision>();

        const resolveBaseDecision = (featureId: FeatureId): FeatureDecision => {
            const buildPolicy = getFeatureBuildPolicyDecision(featureId);
            const localPolicyEnabled = resolveLocalFeaturePolicyEnabled(featureId, params.settings);

            const global = evaluateFeatureDecision({
                featureId,
                scope,
                supportsClient: true,
                buildPolicy,
                localPolicyEnabled,
                serverSupported: true,
                serverEnabled: true,
            });
            if (global.blockedBy && global.blockedBy !== 'server') {
                return global;
            }

            if (!isFeatureServerRepresented(featureId)) {
                return global;
            }

            const serverEnabled = readServerEnabledBit(serverFeatures.features, featureId) === true;
            return evaluateFeatureDecision({
                featureId,
                scope,
                supportsClient: true,
                buildPolicy,
                localPolicyEnabled,
                serverSupported: true,
                serverEnabled,
            });
        };

        const resolveDecision = (featureId: FeatureId): FeatureDecision => {
            const cached = memo.get(featureId);
            if (cached) return cached;

            const base = resolveBaseDecision(featureId);
            if (base.state !== 'enabled') {
                memo.set(featureId, base);
                return base;
            }

            const withDependencies = applyFeatureDependencies({
                featureId,
                baseDecision: base,
                resolveDependencyDecision: resolveDecision,
            });
            memo.set(featureId, withDependencies);
            return withDependencies;
        };

        return resolveDecision(params.featureId);
    };

    const enabledServers: string[] = [];
    const disabledServers: string[] = [];
    const unsupportedServers: string[] = [];
    const erroredServers: string[] = [];
    const unsupportedReasons: string[] = [];
    const errorReasons: string[] = [];

    for (const serverId of serverIds) {
        const snapshot = snapshots[serverId];
        if (!snapshot) {
            // Not expected in ready state, but fail closed.
            erroredServers.push(serverId);
            errorReasons.push('missing_snapshot');
            continue;
        }

        if (snapshot.status === 'error') {
            erroredServers.push(serverId);
            errorReasons.push(snapshot.reason);
            continue;
        }

        if (snapshot.status === 'unsupported') {
            unsupportedServers.push(serverId);
            unsupportedReasons.push(snapshot.reason);
            continue;
        }

        const decision = resolveDecisionForServerFeatures(snapshot);
        if (decision.state === 'enabled') {
            enabledServers.push(serverId);
        } else if (decision.state === 'disabled') {
            disabledServers.push(serverId);
        } else {
            erroredServers.push(serverId);
            errorReasons.push('unknown');
        }
    }

    if (erroredServers.length > 0) {
        return createFeatureDecision({
            featureId: params.featureId,
            state: 'unknown',
            blockedBy: 'server',
            blockerCode: 'probe_failed',
            diagnostics: [
                `scope_server_ids:${serverIds.join(',')}`,
                `server_error_ids:${erroredServers.join(',')}`,
                `server_error_reasons:${Array.from(new Set(errorReasons)).join(',')}`,
            ],
            evaluatedAt: Date.now(),
            scope,
        });
    }

    const hasEnabled = enabledServers.length > 0;
    const hasDisabled = disabledServers.length > 0;
    const hasUnsupported = unsupportedServers.length > 0;
    const hasMixedServerOutcomes =
        (hasEnabled && (hasDisabled || hasUnsupported))
        || (hasDisabled && hasUnsupported);

    if (hasMixedServerOutcomes) {
        return createFeatureDecision({
            featureId: params.featureId,
            state: 'unsupported',
            blockedBy: 'scope',
            blockerCode: 'mixed_scope_support',
            diagnostics: [
                `scope_server_ids:${serverIds.join(',')}`,
                hasEnabled ? `server_enabled_ids:${enabledServers.join(',')}` : 'server_enabled_ids:',
                hasDisabled ? `server_disabled_ids:${disabledServers.join(',')}` : 'server_disabled_ids:',
                hasUnsupported ? `server_unsupported_ids:${unsupportedServers.join(',')}` : 'server_unsupported_ids:',
            ],
            evaluatedAt: Date.now(),
            scope,
        });
    }

    if (hasUnsupported) {
        const reason = Array.from(new Set(unsupportedReasons));
        const blockerCode = reason.length === 1 && reason[0] === 'endpoint_missing' ? 'endpoint_missing' : 'misconfigured';
        return createFeatureDecision({
            featureId: params.featureId,
            state: 'unsupported',
            blockedBy: 'server',
            blockerCode,
            diagnostics: [`scope_server_ids:${serverIds.join(',')}`, `server_unsupported:${reason.join(',')}`],
            evaluatedAt: Date.now(),
            scope,
        });
    }

    if (hasDisabled) {
        return createFeatureDecision({
            featureId: params.featureId,
            state: 'disabled',
            blockedBy: 'server',
            blockerCode: 'feature_disabled',
            diagnostics: [`scope_server_ids:${serverIds.join(',')}`],
            evaluatedAt: Date.now(),
            scope,
        });
    }

    return createFeatureDecision({
        featureId: params.featureId,
        state: 'enabled',
        blockedBy: null,
        blockerCode: 'none',
        diagnostics: [`scope_server_ids:${serverIds.join(',')}`],
        evaluatedAt: Date.now(),
        scope,
    });
}
