import type { AgentId } from '@/agents/catalog';
import type { Metadata } from '@/sync/storageTypes';

import {
    parseAcpConfigOptionsState,
    parseAcpConfigOptionOverridesState,
    parseAcpSessionModelsState,
    parseAcpSessionModesState,
} from './schema';

export type AcpConfigOptionValueId = string;

function normalizeValueId(raw: unknown): AcpConfigOptionValueId | null {
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof raw === 'boolean') return raw ? 'true' : 'false';
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    return null;
}

export type AcpConfigOptionSelectOption = Readonly<{
    value: AcpConfigOptionValueId;
    name: string;
    description?: string;
}>;

export type AcpConfigOption = Readonly<{
    id: string;
    name: string;
    description?: string;
    type: string;
    currentValue: AcpConfigOptionValueId;
    options?: readonly AcpConfigOptionSelectOption[];
}>;

export type AcpConfigOptionControl = Readonly<{
    option: AcpConfigOption;
    requestedValue?: AcpConfigOptionValueId;
    effectiveValue: AcpConfigOptionValueId;
    isPending: boolean;
}>;

export function computeAcpConfigOptionControls(params: {
    agentId: AgentId;
    metadata: Metadata | null | undefined;
}): AcpConfigOptionControl[] | null {
    const state = parseAcpConfigOptionsState(params.metadata?.acpConfigOptionsV1);
    if (!state) return null;
    if (state.provider !== params.agentId) return null;
    if (state.configOptions.length === 0) return null;

    const sessionModes = parseAcpSessionModesState(params.metadata?.acpSessionModesV1);
    const hasDedicatedModeControl = sessionModes?.provider === params.agentId && sessionModes.availableModes.length > 0;

    const sessionModels = parseAcpSessionModelsState(params.metadata?.acpSessionModelsV1);
    const hasDedicatedModelControl =
        sessionModels?.provider === params.agentId && sessionModels.availableModels.length > 0;

    const overrides = parseAcpConfigOptionOverridesState((params.metadata as any)?.acpConfigOptionOverridesV1);
    const controls: AcpConfigOptionControl[] = [];

    for (const entry of state.configOptions) {
        const id = entry.id.trim();
        const name = entry.name.trim();
        const type = entry.type.trim();
        if (!id || !name || !type) continue;

        if (hasDedicatedModeControl && id === 'mode') continue;
        if (hasDedicatedModelControl && (id === 'models' || id === 'model')) continue;

        const currentValue = normalizeValueId(entry.currentValue);
        if (!currentValue) continue;

        const optionsRaw = Array.isArray(entry.options) ? entry.options : [];
        const options = optionsRaw
            .map((opt) => {
                const value = normalizeValueId(opt.value);
                const optName = opt.name.trim();
                if (!value || !optName) return null;
                const optDescription = typeof opt.description === 'string' ? opt.description.trim() : '';
                return { value, name: optName, ...(optDescription ? { description: optDescription } : {}) };
            })
            .filter((value): value is AcpConfigOptionSelectOption => value !== null);

        const description = typeof entry.description === 'string' ? entry.description.trim() : '';
        const option: AcpConfigOption = {
            id,
            name,
            type,
            currentValue,
            ...(description ? { description } : {}),
            ...(options.length > 0 ? { options } : {}),
        };

        const requestedValue = normalizeValueId(overrides?.overrides?.[id]?.value) ?? undefined;
        const effectiveValue = requestedValue ?? currentValue;
        const isPending = requestedValue !== undefined && requestedValue !== currentValue;

        controls.push({
            option,
            ...(requestedValue !== undefined ? { requestedValue } : {}),
            effectiveValue,
            isPending,
        });
    }

    return controls.length > 0 ? controls : null;
}
