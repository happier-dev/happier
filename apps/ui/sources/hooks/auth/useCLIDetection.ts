import { useCallback, useMemo, useRef } from 'react';
import { useMachine } from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useDaemonScopedMachineCapabilitiesCache } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import type { CapabilityDetectResult, CliAuthStatusData, CliCapabilityData, TmuxCapabilityData } from '@/sync/api/capabilities/capabilitiesProtocol';
import { AGENT_IDS, type AgentId, getAgentCore } from '@/agents/catalog/catalog';
import { isAgentAuthProbeSafeForBackgroundChecks } from '@happier-dev/agents';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';

export type CLIAvailability = Readonly<{
    available: Readonly<Record<AgentId, boolean | null>>; // null = unknown/loading, true = installed, false = not installed
    login: Readonly<Record<AgentId, boolean | null>>; // null = unknown/not yet loaded
    authStatus: Readonly<Record<AgentId, CliAuthStatusData | null>>;
    resolvedPath: Readonly<Record<AgentId, string | null>>; // null = unknown/not available
    resolvedCommand?: Readonly<Record<AgentId, string | null>>; // null = unknown/not available
    resolutionSource: Readonly<Record<AgentId, 'override' | 'system' | 'managed' | null>>;
    tmux: boolean | null;
    isDetecting: boolean; // Explicit loading state
    timestamp: number; // When detection completed
    error?: string; // Detection error message (for debugging)
    refresh: (next?: { bypassCache?: boolean; includeLoginStatusForAgentIds?: readonly AgentId[] }) => void;
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
    agentIds?: readonly AgentId[];
    /**
     * Optional explicit agent ids for automatic login-status probing.
     * When omitted and includeLoginStatus=true, only background-safe agents are probed.
     */
    includeLoginStatusForAgentIds?: readonly AgentId[];
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

function normalizeRequestedAgentIds(agentIds: readonly AgentId[] | null | undefined): AgentId[] {
    const normalized: AgentId[] = [];
    const seen = new Set<AgentId>();
    for (const agentId of agentIds ?? []) {
        if (!AGENT_IDS.includes(agentId)) continue;
        if (seen.has(agentId)) continue;
        seen.add(agentId);
        normalized.push(agentId);
    }
    return normalized;
}

function resolveAutomaticLoginStatusAgentIds(includeLoginStatus: boolean, explicitAgentIds?: readonly AgentId[]): AgentId[] {
    if (!includeLoginStatus) return [];
    const normalizedExplicit = normalizeRequestedAgentIds(explicitAgentIds);
    if (normalizedExplicit.length > 0) return normalizedExplicit;
    return AGENT_IDS.filter((agentId) => isAgentAuthProbeSafeForBackgroundChecks(agentId));
}

function buildCliCapabilityId(agentId: AgentId): `cli.${string}` {
    return `cli.${getAgentCore(agentId).cli.detectKey}`;
}

function buildCliDetectionRequest(params: Readonly<{
    agentIds?: readonly AgentId[];
    loginStatusAgentIds?: readonly AgentId[];
    bypassCache?: boolean;
}>) {
    const requestedAgentIds = normalizeRequestedAgentIds(params.agentIds);
    const loginStatusAgentIds = normalizeRequestedAgentIds(params.loginStatusAgentIds);
    const targetAgentIds = requestedAgentIds.length > 0 ? requestedAgentIds : AGENT_IDS;
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
                    id: buildCliCapabilityId(agentId),
                    ...(Object.keys(params).length > 0 ? { params } : {}),
                };
            }),
        };
    }

    const overrides: Record<string, { params: { includeLoginStatus?: true; bypassCache?: true } }> = {};
    for (const agentId of AGENT_IDS) {
        const shouldIncludeLoginStatus = scopedLoginStatusAgentIds.includes(agentId);
        overrides[buildCliCapabilityId(agentId)] = {
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
    const machine = useMachine(machineId ?? '');
    const isOnline = useMemo(() => {
        if (!machineId || !machine) return false;
        return isMachineOnline(machine);
    }, [machine, machineId]);

    const automaticLoginStatusAgentIds = useMemo(
        () => resolveAutomaticLoginStatusAgentIds(Boolean(options?.includeLoginStatus), options?.includeLoginStatusForAgentIds),
        [options?.includeLoginStatus, options?.includeLoginStatusForAgentIds],
    );
    const scopedAgentIds = useMemo(() => normalizeRequestedAgentIds(options?.agentIds), [options?.agentIds]);
    const request = useMemo(
        () => buildCliDetectionRequest({ agentIds: scopedAgentIds, loginStatusAgentIds: automaticLoginStatusAgentIds }),
        [automaticLoginStatusAgentIds, scopedAgentIds],
    );
    const requestKey = useMemo(() => JSON.stringify(request), [request]);
    const serverId = options?.serverId ?? null;

    const { state: cached, refresh } = useDaemonScopedMachineCapabilitiesCache({
        machineId,
        serverId,
        daemonStateVersion: machine?.daemonStateVersion ?? 0,
        enabled: isOnline && options?.autoDetect !== false,
        request,
        staleMs: automaticLoginStatusAgentIds.length > 0 ? 5 * 60_000 : undefined,
    });

    const lastSuccessfulDetectAtRef = useRef<number>(0);
    const fallbackDetectAtRef = useRef<number>(0);
    const lastStableValuesRef = useRef<Readonly<{
        signature: string;
        available: Readonly<Record<AgentId, boolean | null>>;
        login: Readonly<Record<AgentId, boolean | null>>;
        authStatus: Readonly<Record<AgentId, CliAuthStatusData | null>>;
        resolvedPath: Readonly<Record<AgentId, string | null>>;
        resolvedCommand: Readonly<Record<AgentId, string | null>>;
        resolutionSource: Readonly<Record<AgentId, 'override' | 'system' | 'managed' | null>>;
        tmux: boolean | null;
        timestamp: number;
    }> | null>(null);

    const refreshStable = useCallback((next?: { bypassCache?: boolean; includeLoginStatusForAgentIds?: readonly AgentId[] }) => {
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
        if (!machineId || !isOnline) {
            const available: Record<AgentId, boolean | null> = {} as any;
            const login: Record<AgentId, boolean | null> = {} as any;
            const authStatus: Record<AgentId, CliAuthStatusData | null> = {} as any;
            const resolvedPath: Record<AgentId, string | null> = {} as any;
            const resolvedCommand: Record<AgentId, string | null> = {} as any;
            const resolutionSource: Record<AgentId, 'override' | 'system' | 'managed' | null> = {} as any;
            for (const agentId of AGENT_IDS) {
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
            const available: Record<AgentId, boolean | null> = {} as any;
            const login: Record<AgentId, boolean | null> = {} as any;
            const authStatus: Record<AgentId, CliAuthStatusData | null> = {} as any;
            const resolvedPath: Record<AgentId, string | null> = {} as any;
            const resolvedCommand: Record<AgentId, string | null> = {} as any;
            const resolutionSource: Record<AgentId, 'override' | 'system' | 'managed' | null> = {} as any;
            for (const agentId of AGENT_IDS) {
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

        const available: Record<AgentId, boolean | null> = {} as any;
        const login: Record<AgentId, boolean | null> = {} as any;
        const authStatus: Record<AgentId, CliAuthStatusData | null> = {} as any;
        const resolvedPath: Record<AgentId, string | null> = {} as any;
        const resolvedCommand: Record<AgentId, string | null> = {} as any;
        const resolutionSource: Record<AgentId, 'override' | 'system' | 'managed' | null> = {} as any;
        for (const agentId of AGENT_IDS) {
            const capId = buildCliCapabilityId(agentId);
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
    }, [cached, isOnline, machineId, refreshStable, requestKey, serverId]);
}
