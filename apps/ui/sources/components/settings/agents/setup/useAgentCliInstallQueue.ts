import * as React from 'react';

import type { AgentId } from '@/agents/catalog/catalog';
import { buildProviderCliCapabilityId } from '@/capabilities/cliCapabilityId';
import { machineCapabilitiesInvoke } from '@/sync/ops';
import type { CapabilitiesInvokeResponse } from '@/sync/api/capabilities/capabilitiesProtocol';

export type AgentCliInstallStatus = 'idle' | 'queued' | 'installing' | 'installed' | 'failed';

export type AgentCliInstallResult = Readonly<{
    status: AgentCliInstallStatus;
    logPath: string | null;
    failureReason: 'not-supported' | 'error' | 'invoke-error' | null;
}>;

export type AgentCliInstallQueueSummary = Readonly<{
    installedAgentIds: AgentId[];
    failedAgentIds: AgentId[];
}>;

export type AgentCliInstallQueueState = Readonly<{
    isRunning: boolean;
    hasStarted: boolean;
    agentIds: readonly AgentId[];
    statusByProviderId: Readonly<Partial<Record<AgentId, AgentCliInstallResult>>>;
}>;

function resolveInstalledCandidate(installed: boolean | null | undefined): boolean {
    return installed === true;
}

export function useAgentCliInstallQueue(params: Readonly<{
    machineId: string | null;
    serverId: string | null;
    agentIds: readonly AgentId[];
    agentDetectKeys: Readonly<Partial<Record<AgentId, string>>>;
    installedByAgentId: Readonly<Partial<Record<AgentId, boolean | null>>>;
}>) {
    const mountedRef = React.useRef(true);
    const abortRef = React.useRef<{ aborted: boolean }>({ aborted: false });
    const runningRef = React.useRef(false);

    const [hasStarted, setHasStarted] = React.useState(false);
    const [isRunning, setIsRunning] = React.useState(false);
    const [statusByProviderId, setStatusByProviderId] = React.useState<Partial<Record<AgentId, AgentCliInstallResult>>>({});

    React.useEffect(() => {
        return () => {
            mountedRef.current = false;
            abortRef.current.aborted = true;
        };
    }, []);

    const setStatus = React.useCallback((agentId: AgentId, next: AgentCliInstallResult) => {
        if (!mountedRef.current) return;
        setStatusByProviderId((previous) => ({
            ...previous,
            [agentId]: next,
        }));
    }, []);

    const resolveStatus = React.useCallback((agentId: AgentId): AgentCliInstallResult => {
        const override = statusByProviderId[agentId];
        const installed = resolveInstalledCandidate(params.installedByAgentId[agentId]);

        if (installed) {
            return {
                status: 'installed',
                logPath: null,
                failureReason: null,
            };
        }

        return override ?? { status: 'idle', logPath: null, failureReason: null };
    }, [params.installedByAgentId, statusByProviderId]);

    const start = React.useCallback(async (agentIds: readonly AgentId[] = params.agentIds): Promise<AgentCliInstallQueueSummary> => {
        if (runningRef.current) {
            return {
                installedAgentIds: agentIds.filter((id) => resolveStatus(id).status === 'installed'),
                failedAgentIds: agentIds.filter((id) => resolveStatus(id).status === 'failed'),
            };
        }

        setHasStarted(true);
        abortRef.current.aborted = false;
        runningRef.current = true;
        setIsRunning(true);

        const installedAgentIds: AgentId[] = [];
        const failedAgentIds: AgentId[] = [];

        const installTargets: AgentId[] = [];
        for (const agentId of agentIds) {
            if (resolveStatus(agentId).status === 'installed') {
                installedAgentIds.push(agentId);
                continue;
            }
            installTargets.push(agentId);
        }

        for (const agentId of installTargets) {
            setStatus(agentId, { status: 'queued', logPath: null, failureReason: null });
        }

        for (const agentId of installTargets) {
            if (abortRef.current.aborted) break;
            const detectKey = params.agentDetectKeys[agentId];
            if (!params.machineId || !detectKey) {
                setStatus(agentId, { status: 'failed', logPath: null, failureReason: 'error' });
                failedAgentIds.push(agentId);
                continue;
            }

            setStatus(agentId, { status: 'installing', logPath: null, failureReason: null });

            let result: { ok: true; response: CapabilitiesInvokeResponse } | { ok: false; reason: 'not-supported' | 'error' };
            try {
                const invokeRequest = {
                    id: buildProviderCliCapabilityId(agentId),
                    method: 'install' as const,
                    params: {
                        skipIfInstalled: true,
                        allowVendorRecipeExecution: true,
                    },
                };
                const invoked = await machineCapabilitiesInvoke(params.machineId, invokeRequest, {
                    timeoutMs: 5 * 60_000,
                    serverId: params.serverId,
                });
                if (!invoked.supported) {
                    result = { ok: false, reason: invoked.reason };
                } else {
                    result = { ok: true, response: invoked.response };
                }
            } catch {
                result = { ok: false, reason: 'error' };
            }

            if (!result.ok) {
                setStatus(agentId, { status: 'failed', logPath: null, failureReason: result.reason });
                failedAgentIds.push(agentId);
                continue;
            }

            if (!result.response.ok) {
                setStatus(agentId, { status: 'failed', logPath: result.response.logPath ?? null, failureReason: 'invoke-error' });
                failedAgentIds.push(agentId);
                continue;
            }

            setStatus(agentId, { status: 'installed', logPath: null, failureReason: null });
            installedAgentIds.push(agentId);
        }

        if (mountedRef.current) {
            setIsRunning(false);
        }
        runningRef.current = false;

        return { installedAgentIds, failedAgentIds };
    }, [params.machineId, params.agentDetectKeys, params.agentIds, params.serverId, resolveStatus, setStatus]);

    const retry = React.useCallback(async (agentId: AgentId): Promise<AgentCliInstallQueueSummary> => {
        setStatus(agentId, { status: 'queued', logPath: null, failureReason: null });
        return start([agentId]);
    }, [setStatus, start]);

    const reset = React.useCallback(() => {
        abortRef.current.aborted = true;
        runningRef.current = false;
        setIsRunning(false);
        setHasStarted(false);
        setStatusByProviderId({});
    }, []);

    const state: AgentCliInstallQueueState = React.useMemo(() => ({
        isRunning,
        hasStarted,
        agentIds: params.agentIds,
        statusByProviderId,
    }), [hasStarted, isRunning, params.agentIds, statusByProviderId]);

    return {
        state,
        resolveStatus,
        start,
        retry,
        reset,
    } as const;
}
