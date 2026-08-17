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
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    getCachedServerFeaturesSnapshot,
    getServerFeaturesSnapshot,
    getServerFeaturesSnapshotRetryDelayMs,
    subscribeServerFeaturesSnapshot,
    type ServerFeaturesSnapshot,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { getFeatureBuildPolicyDecision } from './featureBuildPolicy';
import { resolveLocalFeaturePolicyEnabled, type FeatureLocalPolicySettings } from './featureLocalPolicy';

const evaluateFeatureDecision = evaluateFeatureDecisionBase;

export type ServerFeaturesRuntimeSnapshot =
    | Readonly<{ status: 'loading' }>
    | ServerFeaturesSnapshot;

export type ServerFeaturesMainSelectionSnapshot =
    | Readonly<{ status: 'loading'; serverIds: string[]; snapshotsByServerId: Record<string, ServerFeaturesSnapshot> }>
    | Readonly<{ status: 'ready'; serverIds: string[]; snapshotsByServerId: Record<string, ServerFeaturesSnapshot> }>;

const LOADING_SERVER_FEATURES_SNAPSHOT = Object.freeze({ status: 'loading' as const });

export function useServerFeaturesRuntimeSnapshot(options?: Readonly<{ enabled?: boolean }>): ServerFeaturesRuntimeSnapshot {
    const enabled = options?.enabled ?? true;
    const [snapshot, setSnapshot] = React.useState<ServerFeaturesRuntimeSnapshot>(() => {
        if (!enabled) return LOADING_SERVER_FEATURES_SNAPSHOT;
        const cached = getCachedServerFeaturesSnapshot();
        return cached ?? LOADING_SERVER_FEATURES_SNAPSHOT;
    });

    React.useEffect(() => {
        if (!enabled) {
            setSnapshot(LOADING_SERVER_FEATURES_SNAPSHOT);
            return;
        }

        let cancelled = false;
        let requestToken = 0;
        let requestGeneration = 0;
        let lastRequestedServerId = '\u0000';
        let retryTimer: ReturnType<typeof setTimeout> | null = null;

        const loadForServerId = async (serverId: string | undefined, generation: number) => {
            const token = requestToken + 1;
            requestToken = token;
            const next = await getServerFeaturesSnapshot({
                serverId,
            });
            if (!cancelled && token === requestToken && generation === requestGeneration) {
                setSnapshot(next);
                const retryDelayMs = getServerFeaturesSnapshotRetryDelayMs({ serverId, snapshot: next });
                if (retryDelayMs !== null) {
                    retryTimer = setTimeout(() => {
                        if (cancelled || generation !== requestGeneration) return;
                        retryTimer = null;
                        fireAndForget(loadForServerId(serverId, generation), {
                            tag: 'useServerFeaturesRuntimeSnapshot.retryTransientError',
                        });
                    }, retryDelayMs);
                }
            }
        };

        const requestLoad = (serverId: string | undefined, tag: string) => {
            const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
            const nextKey = normalizedServerId || '(active)';
            if (nextKey === lastRequestedServerId) return;
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
            lastRequestedServerId = nextKey;
            requestGeneration += 1;
            fireAndForget(loadForServerId(normalizedServerId || undefined, requestGeneration), { tag });
        };

        const unsubscribe = subscribeActiveServer((active) => {
            const serverId = typeof (active as any)?.serverId === 'string' ? String((active as any).serverId).trim() : '';
            if (!serverId) return;

            const cached = getCachedServerFeaturesSnapshot({ serverId });
            setSnapshot(cached ?? LOADING_SERVER_FEATURES_SNAPSHOT);
            requestLoad(serverId, 'useServerFeaturesSnapshot.subscribeActiveServer');
        });
        const unsubscribeSnapshot = subscribeServerFeaturesSnapshot(() => {
            if (cancelled) return;
            const active = getActiveServerSnapshot();
            const serverId = normalizeId(active.serverId);
            const cached = getCachedServerFeaturesSnapshot(
                serverId ? { serverId } : undefined,
            );
            setSnapshot(cached ?? LOADING_SERVER_FEATURES_SNAPSHOT);
        });

        const initialActive = getActiveServerSnapshot();
        const initialServerId = typeof (initialActive as any)?.serverId === 'string' ? String((initialActive as any).serverId).trim() : '';
        if (initialServerId) {
            const cached = getCachedServerFeaturesSnapshot({ serverId: initialServerId });
            setSnapshot(cached ?? LOADING_SERVER_FEATURES_SNAPSHOT);
            requestLoad(initialServerId, 'useServerFeaturesSnapshot.initialLoad');
        } else {
            const cached = getCachedServerFeaturesSnapshot();
            if (cached) setSnapshot(cached);
            requestLoad(undefined, 'useServerFeaturesSnapshot.initialLoad');
        }

        return () => {
            cancelled = true;
            if (retryTimer) clearTimeout(retryTimer);
            unsubscribe();
            unsubscribeSnapshot();
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
        if (!enabled) return LOADING_SERVER_FEATURES_SNAPSHOT;
        if (!serverId) return LOADING_SERVER_FEATURES_SNAPSHOT;
        const cached = getCachedServerFeaturesSnapshot({ serverId });
        return cached ?? LOADING_SERVER_FEATURES_SNAPSHOT;
    });

    React.useEffect(() => {
        if (!enabled) {
            setSnapshot(LOADING_SERVER_FEATURES_SNAPSHOT);
            return () => undefined;
        }

        let cancelled = false;
        let requestToken = 0;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribeSnapshot = subscribeServerFeaturesSnapshot(() => {
            if (cancelled || !serverId) return;
            const cached = getCachedServerFeaturesSnapshot({ serverId });
            setSnapshot(cached ?? LOADING_SERVER_FEATURES_SNAPSHOT);
        });

        const load = async (serverId: string) => {
            const token = requestToken + 1;
            requestToken = token;
            const next = await getServerFeaturesSnapshot({ serverId });
            if (!cancelled && token === requestToken) {
                setSnapshot(next);
                const retryDelayMs = getServerFeaturesSnapshotRetryDelayMs({ serverId, snapshot: next });
                if (retryDelayMs !== null) {
                    retryTimer = setTimeout(() => {
                        if (cancelled) return;
                        fireAndForget(load(serverId), {
                            tag: 'useServerFeaturesSnapshotForServerId.retryTransientError',
                        });
                    }, retryDelayMs);
                }
            }
        };

        if (!serverId) {
            setSnapshot(LOADING_SERVER_FEATURES_SNAPSHOT);
            return () => {
                cancelled = true;
                if (retryTimer) clearTimeout(retryTimer);
                unsubscribeSnapshot();
            };
        }

        const cached = getCachedServerFeaturesSnapshot({ serverId });
        setSnapshot(cached ?? LOADING_SERVER_FEATURES_SNAPSHOT);
        fireAndForget(load(serverId), { tag: 'useServerFeaturesSnapshotForServerId.initialLoad' });

        return () => {
            cancelled = true;
            if (retryTimer) clearTimeout(retryTimer);
            unsubscribeSnapshot();
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

const EMPTY_NORMALIZED_SERVER_IDS: string[] = [];

function buildNormalizedServerIdsKey(raw: ReadonlyArray<string>): string {
    return normalizeServerIds(raw).join('\u0000');
}

function readNormalizedServerIdsFromKey(key: string): string[] {
    return key ? key.split('\u0000') : EMPTY_NORMALIZED_SERVER_IDS;
}

export function useServerFeaturesMainSelectionSnapshot(
    serverIdsRaw: ReadonlyArray<string>,
    options?: Readonly<{ enabled?: boolean }>,
): ServerFeaturesMainSelectionSnapshot {
    const enabled = options?.enabled ?? true;
    const serverIdsKey = React.useMemo(() => buildNormalizedServerIdsKey(serverIdsRaw), [serverIdsRaw]);
    const serverIds = React.useMemo(() => readNormalizedServerIdsFromKey(serverIdsKey), [serverIdsKey]);

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
        if (!enabled) {
            setState({ status: 'ready', serverIds, snapshotsByServerId: {} });
            return;
        }

        if (serverIds.length === 0) {
            setState({ status: 'ready', serverIds, snapshotsByServerId: {} });
            return;
        }

        let cancelled = false;
        let requestToken = 0;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribeSnapshot = subscribeServerFeaturesSnapshot(() => {
            if (cancelled) return;
            const snapshotsByServerId: Record<string, ServerFeaturesSnapshot> = {};
            for (const serverId of serverIds) {
                const cached = getCachedServerFeaturesSnapshot({ serverId });
                if (cached) snapshotsByServerId[serverId] = cached;
            }
            setState((current) => {
                const ready = Object.keys(snapshotsByServerId).length === serverIds.length;
                const nextStatus = ready ? 'ready' as const : 'loading' as const;
                if (
                    current.status === nextStatus
                    && current.serverIds.length === serverIds.length
                    && current.serverIds.every((id, index) => id === serverIds[index])
                    && serverIds.every((id) => current.snapshotsByServerId[id] === snapshotsByServerId[id])
                ) {
                    return current;
                }
                return { status: nextStatus, serverIds, snapshotsByServerId };
            });
        });

        const cleanup = () => {
            cancelled = true;
            if (retryTimer) clearTimeout(retryTimer);
            unsubscribeSnapshot();
        };

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
            const retryDelayMs = results.reduce<number | null>((current, [serverId, snapshot]) => {
                const next = getServerFeaturesSnapshotRetryDelayMs({ serverId, snapshot });
                if (next === null) return current;
                return current === null ? next : Math.min(current, next);
            }, null);
            if (retryDelayMs !== null) {
                retryTimer = setTimeout(() => {
                    if (cancelled) return;
                    fireAndForget(load(serverIds), {
                        tag: 'useServerFeaturesMainSelectionSnapshot.retryTransientError',
                    });
                }, retryDelayMs);
            }
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
            if (Object.values(snapshotsByServerId).some((snapshot) => snapshot.status === 'error')) {
                fireAndForget(load(serverIds), { tag: 'useServerFeaturesMainSelectionSnapshot.retryTransientError' });
            }
            return cleanup;
        }

        setState({ status: 'loading', serverIds, snapshotsByServerId });
        fireAndForget(load(serverIds), { tag: 'useServerFeaturesMainSelectionSnapshot.initialLoad' });

        return cleanup;
    }, [enabled, serverIds]);

    return state;
}

export function resolveRuntimeFeatureDecisionFromSnapshot(params: {
    featureId: FeatureId;
    settings: FeatureLocalPolicySettings;
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
    settings: FeatureLocalPolicySettings;
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
