import type { AgentId } from '@/agents/catalog';
import { getAgentCore } from '@/agents/catalog';
import type { Metadata } from '@/sync/storageTypes';

import { parseAcpSessionModesState, parseAcpSessionModeOverrideState } from './schema';

export type AcpPlanModeControl = Readonly<{
    planOn: boolean;
    offModeId: string | null;
    planModeName: string;
    currentModeName: string;
    requestedModeName: string;
    isPending: boolean;
}>;

export function supportsAcpAgentModeOverrides(agentId: AgentId): boolean {
    return getAgentCore(agentId).sessionModes.kind === 'acpAgentModes';
}

export type AcpSessionModeOption = Readonly<{
    id: string;
    name: string;
    description?: string;
}>;

export type AcpSessionModePickerControl = Readonly<{
    options: readonly AcpSessionModeOption[];
    currentModeId: string;
    currentModeName: string;
    requestedModeId: string | null;
    requestedModeName: string | null;
    effectiveModeId: string;
    effectiveModeName: string;
    isPending: boolean;
}>;

export function computeAcpSessionModePickerControl(params: {
    agentId: AgentId;
    metadata: Metadata | null | undefined;
}): AcpSessionModePickerControl | null {
    if (!supportsAcpAgentModeOverrides(params.agentId)) return null;

    const state = parseAcpSessionModesState(params.metadata?.acpSessionModesV1);
    if (!state) return null;
    if (state.provider !== params.agentId) return null;
    if (state.availableModes.length === 0) return null;

    const options = state.availableModes;
    const currentModeId = state.currentModeId;
    if (!currentModeId) return null;

    const modeOverride = parseAcpSessionModeOverrideState((params.metadata as any)?.acpSessionModeOverrideV1);
    const requestedModeId = modeOverride?.modeId ?? null;
    const effectiveModeId = requestedModeId ?? currentModeId;

    const currentMode = options.find((mode) => mode.id === currentModeId) ?? null;
    const requestedMode = requestedModeId ? options.find((mode) => mode.id === requestedModeId) ?? null : null;
    const effectiveMode = options.find((mode) => mode.id === effectiveModeId) ?? null;
    const isPending = Boolean(requestedModeId && currentModeId && requestedModeId !== currentModeId);

    return {
        options,
        currentModeId,
        currentModeName: currentMode?.name ?? currentModeId,
        requestedModeId,
        requestedModeName: requestedMode?.name ?? requestedModeId,
        effectiveModeId,
        effectiveModeName: effectiveMode?.name ?? effectiveModeId,
        isPending,
    };
}

export function computeAcpPlanModeControl(metadata: Metadata | null | undefined): AcpPlanModeControl | null {
    const state = parseAcpSessionModesState(metadata?.acpSessionModesV1);
    if (!state) return null;

    const available = state.availableModes;
    const hasPlanMode = available.some((mode) => mode.id.toLowerCase() === 'plan');
    if (!hasPlanMode) return null;

    const modeOverride = parseAcpSessionModeOverrideState((metadata as any)?.acpSessionModeOverrideV1);
    const requestedModeId = modeOverride?.modeId ?? '';
    const currentModeId = state.currentModeId;
    const effectiveModeId = requestedModeId || currentModeId;

    const planOn = effectiveModeId.toLowerCase() === 'plan';
    const planMode = available.find((mode) => mode.id.toLowerCase() === 'plan') ?? null;
    const currentMode = available.find((mode) => mode.id === currentModeId) ?? null;
    const requestedMode = requestedModeId ? available.find((mode) => mode.id === requestedModeId) ?? null : null;

    const offModeId = (() => {
        if (currentModeId && currentModeId.toLowerCase() !== 'plan') return currentModeId;
        const fallback = available.find((mode) => mode.id.toLowerCase() !== 'plan');
        return fallback?.id ?? null;
    })();

    const isPending = Boolean(requestedModeId && currentModeId && requestedModeId !== currentModeId);

    return {
        planOn,
        offModeId,
        planModeName: planMode?.name ?? 'Plan',
        currentModeName: currentMode?.name ?? currentModeId,
        requestedModeName: requestedMode?.name ?? requestedModeId,
        isPending,
    };
}
