import * as React from 'react';
import { buildBackendTargetKey, isBuiltInAgentTarget, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { resolveProviderAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { normalizeAcpConfigOptionsArray, type AcpConfigOption } from '@/sync/acp/configOptionsControl';
import type { NewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';

function stableJsonStringify(value: unknown): string {
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((v) => stableJsonStringify(v)).join(',')}]`;

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJsonStringify(obj[k])}`).join(',')}}`;
}

export function useNewSessionPreflightConfigOptionsState(params: Readonly<{
    backendTarget: BackendTargetRefV1;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    probeContext?: NewSessionCapabilityProbeContext | null;
}>): Readonly<{
    configOptions: readonly AcpConfigOption[] | null;
    probe: Readonly<{
        phase: 'idle' | 'loading' | 'refreshing';
        refreshedAt: number | null;
        onRefresh: () => void;
    }>;
}> {
    const [configOptions, setConfigOptions] = React.useState<readonly AcpConfigOption[] | null>(null);
    const [probePhase, setProbePhase] = React.useState<'idle' | 'loading' | 'refreshing'>('idle');
    const [refreshedAt, setRefreshedAt] = React.useState<number | null>(null);
    const [refreshNonce, setRefreshNonce] = React.useState(0);
    const configOptionsRef = React.useRef<readonly AcpConfigOption[] | null>(null);

    React.useEffect(() => {
        configOptionsRef.current = configOptions;
    }, [configOptions]);

    const onRefresh = React.useCallback(() => {
        setRefreshNonce((current) => current + 1);
    }, []);

    const backendTargetKind = params.backendTarget.kind;
    const backendTargetAgentId = isBuiltInAgentTarget(params.backendTarget) ? params.backendTarget.agentId : null;
    const backendTargetBackendId = isBuiltInAgentTarget(params.backendTarget) ? null : params.backendTarget.backendId;

    const backendTarget = React.useMemo<BackendTargetRefV1>(() => {
        return backendTargetKind === 'builtInAgent'
            ? { kind: 'builtInAgent', agentId: backendTargetAgentId! }
            : { kind: 'configuredAcpBackend', backendId: backendTargetBackendId! };
    }, [backendTargetAgentId, backendTargetBackendId, backendTargetKind]);

    const agentType = React.useMemo(() => resolveProviderAgentIdForBackendTarget(backendTarget), [backendTarget]);
    const probeKey = React.useMemo(() => buildBackendTargetKey(backendTarget), [backendTarget]);
    const probeContextKey = React.useMemo(() => stableJsonStringify({
        cacheKeySuffixParts: params.probeContext?.cacheKeySuffixParts ?? null,
        capabilityParams: params.probeContext?.capabilityParams ?? null,
    }), [params.probeContext?.cacheKeySuffixParts, params.probeContext?.capabilityParams]);

    React.useEffect(() => {
        if (!params.selectedMachineId) {
            setConfigOptions(null);
            setProbePhase('idle');
            setRefreshedAt(null);
            return;
        }

        let cancelled = false;
        const run = async () => {
            setProbePhase(configOptionsRef.current ? 'refreshing' : 'loading');
            const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';
            const response = await machineCapabilitiesInvoke(
                params.selectedMachineId!,
                {
                    id: `cli.${agentType}` as any,
                    method: 'probeConfigOptions',
                    params: {
                        timeoutMs: 15_000,
                        backendTarget,
                        ...(params.probeContext?.capabilityParams ? params.probeContext.capabilityParams : {}),
                        ...(cwd ? { cwd } : {}),
                    },
                },
                {
                    serverId: params.capabilityServerId,
                },
            );

            if (cancelled) return;
            const parsed = response.supported && response.response.ok
                ? normalizeAcpConfigOptionsArray((response.response.result as any)?.configOptions)
                : null;
            setConfigOptions(parsed);
            setRefreshedAt(Date.now());
            setProbePhase('idle');
        };

        void run();
        return () => {
            cancelled = true;
        };
    }, [agentType, backendTarget, params.capabilityServerId, params.cwd, probeContextKey, probeKey, params.selectedMachineId, refreshNonce]);

    return {
        configOptions,
        probe: {
            phase: probePhase,
            refreshedAt,
            onRefresh,
        },
    };
}
