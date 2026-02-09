import * as React from 'react';

import type { AgentId } from '@/agents/registry/registryCore';
import {
    getModelOptionsForAgentTypeOrPreflight,
    supportsFreeformModelSelectionForSession,
    type PreflightModelList,
} from '@/sync/domains/models/modelOptions';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';

type MediatorAgentSource = 'session' | 'agent';

type UseModelPreflightInput = Readonly<{
    source: MediatorAgentSource | null | undefined;
    agentId: string | null | undefined;
    recentMachinePaths: unknown;
}>;

function resolveMachineIdForModelPreflight(recentMachinePaths: unknown): string | null {
    const first = Array.isArray(recentMachinePaths) ? recentMachinePaths[0] : null;
    const machineId = first && typeof first === 'object' && typeof (first as { machineId?: unknown }).machineId === 'string'
        ? String((first as { machineId: string }).machineId).trim()
        : '';
    return machineId || null;
}

export function resolveMediatorAgentIdForModelMenus(input: Readonly<{
    source: MediatorAgentSource | null | undefined;
    agentId: string | null | undefined;
}>): AgentId {
    if (input.source === 'agent') {
        return ((input.agentId ?? 'claude') as AgentId);
    }
    // Session source can vary per session; keep Claude as best-effort options source.
    return 'claude';
}

export function normalizePreflightModelList(raw: unknown): PreflightModelList | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const payload = raw as {
        availableModels?: unknown;
        supportsFreeform?: unknown;
    };
    if (!Array.isArray(payload.availableModels)) {
        return null;
    }

    const availableModels = payload.availableModels
        .filter((model): model is { id: string; name: string; description?: string } => {
            return Boolean(
                model &&
                typeof model === 'object' &&
                typeof (model as { id?: unknown }).id === 'string' &&
                typeof (model as { name?: unknown }).name === 'string',
            );
        })
        .map((model) => ({
            id: String(model.id),
            name: String(model.name),
            ...(typeof model.description === 'string' ? { description: model.description } : {}),
        }));

    return {
        availableModels,
        supportsFreeform: payload.supportsFreeform === true,
    };
}

export function useModelPreflight(input: UseModelPreflightInput): Readonly<{
    daemonMediatorModelOptions: readonly { value: string; label: string; description?: string }[];
    daemonMediatorSupportsFreeform: boolean;
}> {
    const resolvedAgentId = React.useMemo(
        () => resolveMediatorAgentIdForModelMenus({ source: input.source, agentId: input.agentId }),
        [input.source, input.agentId],
    );

    const machineIdForModelPreflight = React.useMemo(
        () => resolveMachineIdForModelPreflight(input.recentMachinePaths),
        [input.recentMachinePaths],
    );

    const [preflightModels, setPreflightModels] = React.useState<PreflightModelList | null>(null);

    React.useEffect(() => {
        if (!machineIdForModelPreflight) {
            setPreflightModels(null);
            return;
        }

        let cancelled = false;

        const run = async () => {
            const res = await machineCapabilitiesInvoke(machineIdForModelPreflight, {
                id: `cli.${resolvedAgentId}` as any,
                method: 'probeModels',
                params: { timeoutMs: 3500 },
            });

            if (cancelled || !res.supported || !res.response.ok) {
                return;
            }

            const normalized = normalizePreflightModelList(res.response.result);
            if (!normalized) {
                return;
            }
            setPreflightModels(normalized);
        };

        void run();

        return () => {
            cancelled = true;
        };
    }, [machineIdForModelPreflight, resolvedAgentId]);

    const daemonMediatorModelOptions = React.useMemo(() => {
        const options = getModelOptionsForAgentTypeOrPreflight({
            agentType: resolvedAgentId,
            preflight: preflightModels,
        });
        if (options.length > 0) {
            return options;
        }
        return [{ value: 'default', label: 'Default', description: '' }] as const;
    }, [resolvedAgentId, preflightModels]);

    const daemonMediatorSupportsFreeform = React.useMemo(() => {
        if (preflightModels?.supportsFreeform === true) {
            return true;
        }
        return supportsFreeformModelSelectionForSession(resolvedAgentId, null);
    }, [resolvedAgentId, preflightModels]);

    return { daemonMediatorModelOptions, daemonMediatorSupportsFreeform };
}
