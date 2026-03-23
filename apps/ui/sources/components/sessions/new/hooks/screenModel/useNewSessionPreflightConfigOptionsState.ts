import * as React from 'react';
import { buildBackendTargetKey, isBuiltInAgentTarget, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { resolveProviderAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import type { AcpConfigOption } from '@/sync/acp/configOptionsControl';
import type { NewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';

function normalizeValueId(value: unknown): string | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return null;
}

function normalizePreflightConfigOptions(value: unknown): AcpConfigOption[] | null {
    if (!Array.isArray(value) || value.length === 0) return null;

    const parsed: AcpConfigOption[] = [];
    type RawConfigOptionChoice = Record<string, unknown>;
    for (const entry of value) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
            const id = typeof entry.id === 'string' ? entry.id.trim() : '';
            const name = typeof entry.name === 'string' ? entry.name.trim() : '';
            const type = typeof entry.type === 'string' ? entry.type.trim() : '';
            if (!id || !name || !type) continue;

            const currentValue = normalizeValueId(entry.currentValue);
            if (!currentValue) continue;

            const options = Array.isArray(entry.options)
                ? entry.options
                    .filter((option: unknown): option is RawConfigOptionChoice => Boolean(option && typeof option === 'object' && !Array.isArray(option)))
                    .map((option: RawConfigOptionChoice) => {
                        const value = normalizeValueId(option.value);
                        const optionName = typeof option.name === 'string' ? option.name.trim() : '';
                        if (!value || !optionName) return null;
                        const description = typeof option.description === 'string' ? option.description.trim() : '';
                        return { value, name: optionName, ...(description ? { description } : {}) };
                    })
                    .filter((option: NonNullable<AcpConfigOption['options']>[number] | null): option is NonNullable<AcpConfigOption['options']>[number] => option !== null)
                : undefined;

            const description = typeof entry.description === 'string' ? entry.description.trim() : '';
            parsed.push({
                id,
                name,
                type,
                currentValue,
                ...(description ? { description } : {}),
                ...(options && options.length > 0 ? { options } : {}),
            } satisfies AcpConfigOption);
    }

    return parsed.length > 0 ? parsed : null;
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
    const probeKey = React.useMemo(
        () => buildBackendTargetKey(backendTarget),
        [backendTarget],
    );

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
                ? normalizePreflightConfigOptions((response.response.result as any)?.configOptions)
                : null;
            setConfigOptions(parsed);
            setRefreshedAt(Date.now());
            setProbePhase('idle');
        };

        void run();
        return () => {
            cancelled = true;
        };
    }, [agentType, backendTarget, params.capabilityServerId, params.cwd, params.probeContext?.capabilityParams, probeKey, params.selectedMachineId, refreshNonce]);

    return {
        configOptions,
        probe: {
            phase: probePhase,
            refreshedAt,
            onRefresh,
        },
    };
}
