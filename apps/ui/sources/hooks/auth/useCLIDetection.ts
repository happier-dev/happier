import { useCallback, useMemo, useRef } from 'react';
import { buildProviderCliCapabilityId } from '@/capabilities/cliCapabilityId';
import { useMachineCliDetectionTarget } from '@/sync/domains/state/storage';
import { useDaemonScopedMachineCapabilitiesCache } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import type { CapabilityDetectResult, CliAuthStatusData, CliCapabilityData, TmuxCapabilityData } from '@/sync/api/capabilities/capabilitiesProtocol';
import {
    AGENT_IDS,
    type AgentId,
    isAgentAuthProbeSafeForBackgroundChecks,
} from '@happier-dev/agents';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

const CLI_PROBE_AGENT_IDS: readonly AgentId[] = AGENT_IDS;

export type CLIAvailability = Readonly<{
    available: Readonly<Record<string, boolean | null>>; // null = unknown/loading, true = installed, false = not installed
    login: Readonly<Record<string, boolean | null>>; // null = unknown/not yet loaded
    authStatus: Readonly<Record<string, CliAuthStatusData | null>>;
    resolvedPath: Readonly<Record<string, string | null>>; // null = unknown/not available
    resolvedCommand?: Readonly<Record<string, string | null>>; // null = unknown/not available
    resolutionSource: Readonly<Record<string, 'override' | 'system' | 'managed' | null>>;
    tmux: boolean | null;
    isDetecting: boolean; // Explicit loading state
    timestamp: number; // When detection completed
    error?: string; // Detection error message (for debugging)
    refresh: (next?: { bypassCache?: boolean; includeLoginStatusForAgentIds?: readonly string[] }) => void;
}>;

export interface UseCLIDetectionOptions {
    /**
     * When false, the hook will be cache-only (no automatic detection refresh).
     */
    autoDetect?: boolean;
    /**
     * When true, requests login status detection (best-effort; may return null).
     */
    includeLoginStatus?: boolean;
    /**
     * Optional explicit agent ids to scope the CLI capability request.
     * When omitted, the hook falls back to the canonical new-session checklist.
     */
    agentIds?: readonly string[];
    /**
     * Optional explicit agent ids for automatic login-status probing.
     * When omitted and includeLoginStatus=true, only background-safe agents are probed.
     */
    includeLoginStatusForAgentIds?: readonly string[];
    /**
     * Optional explicit server scope for machine capability cache entries.
     */
    serverId?: string | null;
}

function readCliAvailable(result: CapabilityDetectResult | undefined): boolean | null {
    if (!result || !result.ok) return null;
    const data = result.data as Partial<CliCapabilityData> | undefined;
    return typeof data?.available === 'boolean' ? data.available : null;
}

function readCliLogin(result: CapabilityDetectResult | undefined): boolean | null {
    if (!result || !result.ok) return null;
    const data = result.data as Partial<CliCapabilityData> | undefined;
    const v = data?.isLoggedIn;
    return typeof v === 'boolean' ? v : null;
}

function readCliAuthStatus(result: CapabilityDetectResult | undefined): CliAuthStatusData | null {
    if (!result || !result.ok) return null;
    const data = result.data as Partial<CliCapabilityData> | undefined;
    const value = data?.authStatus;
    if (!value || typeof value !== 'object') return null;
    if (value.state !== 'logged_in' && value.state !== 'logged_out' && value.state !== 'unknown') return null;
    if (typeof value.checkedAt !== 'number') return null;
    return value as CliAuthStatusData;
}

function readCliResolvedPath(result: CapabilityDetectResult | undefined): string | null {
    if (!result || !result.ok) return null;
    const data = result.data as Partial<CliCapabilityData> | undefined;
    return typeof data?.resolvedPath === 'string' ? data.resolvedPath : null;
}

function readCliResolvedCommand(result: CapabilityDetectResult | undefined): string | null {
    if (!result || !result.ok) return null;
    const data = result.data as Partial<CliCapabilityData> | undefined;
    return typeof data?.resolvedCommand === 'string' ? data.resolvedCommand : null;
}

function readCliResolutionSource(result: CapabilityDetectResult | undefined): 'override' | 'system' | 'managed' | null {
    if (!result || !result.ok) return null;
    const data = result.data as Partial<CliCapabilityData> | undefined;
    return data?.resolutionSource === 'override' || data?.resolutionSource === 'system' || data?.resolutionSource === 'managed'
        ? data.resolutionSource
        : null;
}

function normalizeRequestedAgentIds(agentIds: readonly string[] | null | undefined): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const agentId of agentIds ?? []) {
        const normalizedAgentId = agentId.trim();
        if (!normalizedAgentId || seen.has(normalizedAgentId)) continue;
        seen.add(normalizedAgentId);
        normalized.push(normalizedAgentId);
    }
    return normalized;
}

function resolveAutomaticLoginStatusAgentIds(includeLoginStatus: boolean, explicitAgentIds?: readonly string[]): string[] {
    if (!includeLoginStatus) return [];
    const normalizedExplicit = normalizeRequestedAgentIds(explicitAgentIds);
    if (normalizedExplicit.length > 0) return normalizedExplicit;
    return CLI_PROBE_AGENT_IDS.filter((agentId) => isAgentAuthProbeSafeForBackgroundChecks(agentId));
}

function buildCliDetectionRequest(params: Readonly<{
    agentIds?: readonly string[];
    loginStatusAgentIds?: readonly string[];
    bypassCache?: boolean;
}>) {
    const requestedAgentIds = normalizeRequestedAgentIds(params.agentIds);
    const loginStatusAgentIds = normalizeRequestedAgentIds(params.loginStatusAgentIds);
    const targetAgentIds: readonly string[] = requestedAgentIds.length > 0 ? requestedAgentIds : CLI_PROBE_AGENT_IDS;
    const scopedLoginStatusAgentIds = loginStatusAgentIds.filter((agentId) => targetAgentIds.includes(agentId));
    const bypassCache = params.bypassCache === true;
    if (requestedAgentIds.length === 0 && scopedLoginStatusAgentIds.length === 0 && !bypassCache) {
        return { checklistId: CHECKLIST_IDS.NEW_SESSION };
    }

    if (requestedAgentIds.length > 0) {
        return {
            requests: targetAgentIds.map((agentId) => {
                const params: { includeLoginStatus?: true; bypassCache?: true } = {};
                if (scopedLoginStatusAgentIds.includes(agentId)) params.includeLoginStatus = true;
                if (bypassCache) params.bypassCache = true;
                return {
                    id: buildProviderCliCapabilityId(agentId),
                    ...(Object.keys(params).length > 0 ? { params } : {}),
                };
            }),
        };
    }

    const overrides: Record<string, { params: { includeLoginStatus?: true; bypassCache?: true } }> = {};
    for (const agentId of CLI_PROBE_AGENT_IDS) {
        const shouldIncludeLoginStatus = scopedLoginStatusAgentIds.includes(agentId);
        overrides[buildProviderCliCapabilityId(agentId)] = {
            params: {
                ...(shouldIncludeLoginStatus ? { includeLoginStatus: true } : {}),
                ...(bypassCache ? { bypassCache: true } : {}),
            },
        };
    }
    return {
        checklistId: CHECKLIST_IDS.NEW_SESSION,
        overrides: overrides as any,
    };
}

function readTmuxAvailable(result: CapabilityDetectResult | undefined): boolean | null {
    if (!result || !result.ok) return null;
    const data = result.data as Partial<TmuxCapabilityData> | undefined;
    return typeof data?.available === 'boolean' ? data.available : null;
}

export function useCLIDetection(machineId: string | null, options?: UseCLIDetectionOptions): CLIAvailability {
    const machineTarget = useMachineCliDetectionTarget(machineId);
    const isOnline = machineId ? machineTarget.isOnline : false;

    const includeLoginStatusForAgentIdsKey = stableJsonStringify(options?.includeLoginStatusForAgentIds ?? null);
    const agentIdsKey = stableJsonStringify(options?.agentIds ?? null);

    const automaticLoginStatusAgentIds = useMemo(
        () => resolveAutomaticLoginStatusAgentIds(Boolean(options?.includeLoginStatus), options?.includeLoginStatusForAgentIds),
        [options?.includeLoginStatus, includeLoginStatusForAgentIdsKey],
    );
    const scopedAgentIds = useMemo(() => normalizeRequestedAgentIds(options?.agentIds), [agentIdsKey]);
    const request = useMemo(
        () => buildCliDetectionRequest({ agentIds: scopedAgentIds, loginStatusAgentIds: automaticLoginStatusAgentIds }),
        [automaticLoginStatusAgentIds, scopedAgentIds],
    );
    const requestKey = useMemo(() => JSON.stringify(request), [request]);
    const serverId = options?.serverId ?? null;

    const { state: cached, refresh } = useDaemonScopedMachineCapabilitiesCache({
        machineId,
        serverId,
        daemonStateVersion: machineTarget.daemonStateVersion,
        enabled: isOnline && options?.autoDetect !== false,
        request,
        staleMs: automaticLoginStatusAgentIds.length > 0 ? 5 * 60_000 : undefined,
    });

    const lastSuccessfulDetectAtRef = useRef<number>(0);
    const fallbackDetectAtRef = useRef<number>(0);
    const lastStableValuesRef = useRef<Readonly<{
        signature: string;
        available: Readonly<Record<string, boolean | null>>;
        login: Readonly<Record<string, boolean | null>>;
        authStatus: Readonly<Record<string, CliAuthStatusData | null>>;
        resolvedPath: Readonly<Record<string, string | null>>;
        resolvedCommand: Readonly<Record<string, string | null>>;
        resolutionSource: Readonly<Record<string, 'override' | 'system' | 'managed' | null>>;
        tmux: boolean | null;
        timestamp: number;
    }> | null>(null);

    const refreshStable = useCallback((next?: { bypassCache?: boolean; includeLoginStatusForAgentIds?: readonly string[] }) => {
        if (!machineId || !isOnline) return;
        if (next?.bypassCache) {
            refresh({
                request: buildCliDetectionRequest({
                    agentIds: scopedAgentIds,
                    loginStatusAgentIds: next.includeLoginStatusForAgentIds ?? automaticLoginStatusAgentIds,
                    bypassCache: true,
                }),
            });
            return;
        }
        refresh();
    }, [automaticLoginStatusAgentIds, isOnline, machineId, refresh, scopedAgentIds]);

    return useMemo((): CLIAvailability => {
        const probeAgentIds = scopedAgentIds.length > 0 ? scopedAgentIds : CLI_PROBE_AGENT_IDS;
        if (!machineId || !isOnline) {
            const available: Record<string, boolean | null> = {};
            const login: Record<string, boolean | null> = {};
            const authStatus: Record<string, CliAuthStatusData | null> = {};
            const resolvedPath: Record<string, string | null> = {};
            const resolvedCommand: Record<string, string | null> = {};
            const resolutionSource: Record<string, 'override' | 'system' | 'managed' | null> = {};
            for (const agentId of probeAgentIds) {
                available[agentId] = null;
                login[agentId] = null;
                authStatus[agentId] = null;
                resolvedPath[agentId] = null;
                resolvedCommand[agentId] = null;
                resolutionSource[agentId] = null;
            }
            return {
                available,
                login,
                authStatus,
                resolvedPath,
                resolvedCommand,
                resolutionSource,
                tmux: null,
                isDetecting: false,
                timestamp: 0,
                refresh: refreshStable,
            };
        }

        const signature = `${machineId}:${serverId ?? ''}:${requestKey}`;
        const snapshot =
            cached.status === 'loaded'
                ? cached.snapshot
                : cached.status === 'loading'
                    ? cached.snapshot
                    : cached.status === 'error'
                        ? cached.snapshot
                        : undefined;

        const results = snapshot?.response.results ?? {};
        const resultsById = results as Record<string, CapabilityDetectResult | undefined>;
        const now = Date.now();
        const latestCheckedAt = Math.max(
            0,
            ...(Object.values(results)
                .map((r) => (r && typeof r.checkedAt === 'number' ? r.checkedAt : 0))),
        );

        if (cached.status === 'loaded' && latestCheckedAt > 0) {
            lastSuccessfulDetectAtRef.current = latestCheckedAt;
            fallbackDetectAtRef.current = 0;
        } else if (cached.status === 'loaded' && latestCheckedAt === 0 && lastSuccessfulDetectAtRef.current === 0 && fallbackDetectAtRef.current === 0) {
            // Older/broken snapshots could omit checkedAt values; keep a stable "loaded" timestamp
            // rather than flapping Date.now() on re-renders.
            fallbackDetectAtRef.current = now;
        }

        if (!snapshot) {
            const stable = lastStableValuesRef.current;
            if (stable && stable.signature === signature) {
                return {
                    available: stable.available,
                    login: stable.login,
                    authStatus: stable.authStatus,
                    resolvedPath: stable.resolvedPath,
                    resolvedCommand: stable.resolvedCommand,
                    resolutionSource: stable.resolutionSource,
                    tmux: stable.tmux,
                    isDetecting: cached.status === 'loading',
                    timestamp: stable.timestamp,
                    ...(cached.status === 'error' ? { error: 'Detection error' } : {}),
                    refresh: refreshStable,
                };
            }
            const available: Record<string, boolean | null> = {};
            const login: Record<string, boolean | null> = {};
            const authStatus: Record<string, CliAuthStatusData | null> = {};
            const resolvedPath: Record<string, string | null> = {};
            const resolvedCommand: Record<string, string | null> = {};
            const resolutionSource: Record<string, 'override' | 'system' | 'managed' | null> = {};
            for (const agentId of probeAgentIds) {
                available[agentId] = null;
                login[agentId] = null;
                authStatus[agentId] = null;
                resolvedPath[agentId] = null;
                resolvedCommand[agentId] = null;
                resolutionSource[agentId] = null;
            }
            return {
                available,
                login,
                authStatus,
                resolvedPath,
                resolvedCommand,
                resolutionSource,
                tmux: null,
                isDetecting: cached.status === 'loading',
                timestamp: 0,
                ...(cached.status === 'error' ? { error: 'Detection error' } : {}),
                refresh: refreshStable,
            };
        }

        const available: Record<string, boolean | null> = {};
        const login: Record<string, boolean | null> = {};
        const authStatus: Record<string, CliAuthStatusData | null> = {};
        const resolvedPath: Record<string, string | null> = {};
        const resolvedCommand: Record<string, string | null> = {};
        const resolutionSource: Record<string, 'override' | 'system' | 'managed' | null> = {};
        for (const agentId of probeAgentIds) {
            const capId = buildProviderCliCapabilityId(agentId);
            available[agentId] = readCliAvailable(resultsById[capId]);
            login[agentId] = readCliLogin(resultsById[capId]);
            authStatus[agentId] = readCliAuthStatus(resultsById[capId]);
            resolvedPath[agentId] = readCliResolvedPath(resultsById[capId]);
            resolvedCommand[agentId] = readCliResolvedCommand(resultsById[capId]);
            resolutionSource[agentId] = readCliResolutionSource(resultsById[capId]);
        }

        const nextTimestamp =
            lastSuccessfulDetectAtRef.current || latestCheckedAt || fallbackDetectAtRef.current || 0;
        lastStableValuesRef.current = {
            signature,
            available,
            login,
            authStatus,
            resolvedPath,
            resolvedCommand,
            resolutionSource,
            tmux: readTmuxAvailable(results['tool.tmux']),
            timestamp: nextTimestamp,
        };

        return {
            available,
            login,
            authStatus,
            resolvedPath,
            resolvedCommand,
            resolutionSource,
            tmux: readTmuxAvailable(results['tool.tmux']),
            isDetecting: cached.status === 'loading',
            timestamp: nextTimestamp,
            refresh: refreshStable,
        };
    }, [cached, isOnline, machineId, refreshStable, requestKey, scopedAgentIds, serverId]);
}
