import * as React from 'react';

import type { AgentId } from '@/agents/catalog/catalog';
import { machineCapabilitiesInvoke } from '@/sync/ops';
import type { CapabilityId, CapabilitiesInvokeResponse } from '@/sync/api/capabilities/capabilitiesProtocol';

export type ProviderCliInstallStatus = 'idle' | 'queued' | 'installing' | 'installed' | 'failed';

export type ProviderCliInstallResult = Readonly<{
    status: ProviderCliInstallStatus;
    logPath: string | null;
    failureReason: 'not-supported' | 'error' | 'invoke-error' | null;
}>;

export type ProviderCliInstallQueueSummary = Readonly<{
    installedProviderIds: AgentId[];
    failedProviderIds: AgentId[];
}>;

export type ProviderCliInstallQueueState = Readonly<{
    isRunning: boolean;
    hasStarted: boolean;
    providerIds: readonly AgentId[];
    statusByProviderId: Readonly<Partial<Record<AgentId, ProviderCliInstallResult>>>;
}>;

function buildProviderCapabilityId(detectKey: string): Extract<CapabilityId, `cli.${string}`> {
    return `cli.${detectKey}`;
}

function resolveInstalledCandidate(installed: boolean | null | undefined): boolean {
    return installed === true;
}

export function useProviderCliInstallQueue(params: Readonly<{
    machineId: string | null;
    serverId: string | null;
    providerIds: readonly AgentId[];
    providerDetectKeys: Readonly<Partial<Record<AgentId, string>>>;
    installedByProviderId: Readonly<Partial<Record<AgentId, boolean | null>>>;
}>) {
    const mountedRef = React.useRef(true);
    const abortRef = React.useRef<{ aborted: boolean }>({ aborted: false });
    const runningRef = React.useRef(false);

    const [hasStarted, setHasStarted] = React.useState(false);
    const [isRunning, setIsRunning] = React.useState(false);
    const [statusByProviderId, setStatusByProviderId] = React.useState<Partial<Record<AgentId, ProviderCliInstallResult>>>({});

    React.useEffect(() => {
        return () => {
            mountedRef.current = false;
            abortRef.current.aborted = true;
        };
    }, []);

    const setStatus = React.useCallback((providerId: AgentId, next: ProviderCliInstallResult) => {
        if (!mountedRef.current) return;
        setStatusByProviderId((previous) => ({
            ...previous,
            [providerId]: next,
        }));
    }, []);

    const resolveStatus = React.useCallback((providerId: AgentId): ProviderCliInstallResult => {
        const override = statusByProviderId[providerId];
        const installed = resolveInstalledCandidate(params.installedByProviderId[providerId]);

        if (installed) {
            return {
                status: 'installed',
                logPath: null,
                failureReason: null,
            };
        }

        return override ?? { status: 'idle', logPath: null, failureReason: null };
    }, [params.installedByProviderId, statusByProviderId]);

    const start = React.useCallback(async (providerIds: readonly AgentId[] = params.providerIds): Promise<ProviderCliInstallQueueSummary> => {
        if (runningRef.current) {
            return {
                installedProviderIds: providerIds.filter((id) => resolveStatus(id).status === 'installed'),
                failedProviderIds: providerIds.filter((id) => resolveStatus(id).status === 'failed'),
            };
        }

        setHasStarted(true);
        abortRef.current.aborted = false;
        runningRef.current = true;
        setIsRunning(true);

        const installedProviderIds: AgentId[] = [];
        const failedProviderIds: AgentId[] = [];

        const installTargets: AgentId[] = [];
        for (const providerId of providerIds) {
            if (resolveStatus(providerId).status === 'installed') {
                installedProviderIds.push(providerId);
                continue;
            }
            installTargets.push(providerId);
        }

        for (const providerId of installTargets) {
            setStatus(providerId, { status: 'queued', logPath: null, failureReason: null });
        }

        for (const providerId of installTargets) {
            if (abortRef.current.aborted) break;
            const detectKey = params.providerDetectKeys[providerId];
            if (!params.machineId || !detectKey) {
                setStatus(providerId, { status: 'failed', logPath: null, failureReason: 'error' });
                failedProviderIds.push(providerId);
                continue;
            }

            setStatus(providerId, { status: 'installing', logPath: null, failureReason: null });

            let result: { ok: true; response: CapabilitiesInvokeResponse } | { ok: false; reason: 'not-supported' | 'error' };
            try {
                const invokeRequest = {
                    id: buildProviderCapabilityId(detectKey),
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
                setStatus(providerId, { status: 'failed', logPath: null, failureReason: result.reason });
                failedProviderIds.push(providerId);
                continue;
            }

            if (!result.response.ok) {
                setStatus(providerId, { status: 'failed', logPath: result.response.logPath ?? null, failureReason: 'invoke-error' });
                failedProviderIds.push(providerId);
                continue;
            }

            setStatus(providerId, { status: 'installed', logPath: null, failureReason: null });
            installedProviderIds.push(providerId);
        }

        if (mountedRef.current) {
            setIsRunning(false);
        }
        runningRef.current = false;

        return { installedProviderIds, failedProviderIds };
    }, [params.machineId, params.providerDetectKeys, params.providerIds, params.serverId, resolveStatus, setStatus]);

    const retry = React.useCallback(async (providerId: AgentId): Promise<ProviderCliInstallQueueSummary> => {
        setStatus(providerId, { status: 'queued', logPath: null, failureReason: null });
        return start([providerId]);
    }, [setStatus, start]);

    const reset = React.useCallback(() => {
        abortRef.current.aborted = true;
        runningRef.current = false;
        setIsRunning(false);
        setHasStarted(false);
        setStatusByProviderId({});
    }, []);

    const state: ProviderCliInstallQueueState = React.useMemo(() => ({
        isRunning,
        hasStarted,
        providerIds: params.providerIds,
        statusByProviderId,
    }), [hasStarted, isRunning, params.providerIds, statusByProviderId]);

    return {
        state,
        resolveStatus,
        start,
        retry,
        reset,
    } as const;
}
