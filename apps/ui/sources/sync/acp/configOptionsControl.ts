import type { AgentId } from '@/agents/catalog/catalog';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import {
    LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY,
    LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
    LEGACY_ACP_SESSION_MODELS_STATE_KEY,
    LEGACY_ACP_SESSION_MODES_STATE_KEY,
    readMetadataAliasValue,
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_CONFIG_OPTION_OVERRIDES_KEY,
    SESSION_MODELS_STATE_KEY,
    SESSION_MODES_STATE_KEY,
} from '@happier-dev/agents';

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

export function isBooleanConfigOptionType(type: string): boolean {
    return type === 'boolean' || type === 'bool' || type === 'toggle';
}

export function resolveBooleanConfigOptionToggleValues(option: AcpConfigOption): Readonly<{
    offValue: AcpConfigOptionValueId;
    onValue: AcpConfigOptionValueId;
}> {
    const optionValues = Array.isArray(option.options)
        ? option.options
            .map((entry) => normalizeValueId(entry.value))
            .filter((value): value is AcpConfigOptionValueId => value !== null)
        : [];

    if (optionValues.length >= 2) {
        return {
            offValue: optionValues[0],
            onValue: optionValues[1],
        };
    }

    return {
        offValue: 'false',
        onValue: 'true',
    };
}

export function resolveBooleanConfigOptionValue(option: AcpConfigOption, value: AcpConfigOptionValueId): boolean {
    const { onValue } = resolveBooleanConfigOptionToggleValues(option);
    return value === onValue;
}

export function resolveBooleanConfigOptionNextValue(option: AcpConfigOption, enabled: boolean): AcpConfigOptionValueId {
    const { offValue, onValue } = resolveBooleanConfigOptionToggleValues(option);
    return enabled ? onValue : offValue;
}

function buildAcpConfigOptionControls(params: Readonly<{
    providerId: string;
    provider: string | null;
    configOptions: ReadonlyArray<{
        id: string;
        name: string;
        description?: string;
        type: string;
        currentValue: unknown;
        options?: ReadonlyArray<{
            value: unknown;
            name: string;
            description?: string;
        }>;
    }>;
    overrides?: Readonly<Record<string, Readonly<{ value: unknown }>>> | null;
    hideModeOption: boolean;
    hideModelOption: boolean;
}>): AcpConfigOptionControl[] | null {
    if (params.provider !== params.providerId) return null;

    const controls: AcpConfigOptionControl[] = [];

    for (const entry of params.configOptions) {
        const id = entry.id.trim();
        const name = entry.name.trim();
        const type = entry.type.trim();
        if (!id || !name || !type) continue;

        if (params.hideModeOption && id === 'mode') continue;
        if (params.hideModelOption && (id === 'models' || id === 'model')) continue;

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

        const requestedValue = normalizeValueId(params.overrides?.[id]?.value) ?? undefined;
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

export function computeAcpConfigOptionControls(params: {
    agentId: AgentId;
    metadata: Metadata | null | undefined;
}): AcpConfigOptionControl[] | null {
    const state = parseAcpConfigOptionsState(
        readMetadataAliasValue((params.metadata as any) ?? {}, SESSION_CONFIG_OPTIONS_STATE_KEY, LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY),
    );
    if (!state) return null;
    if (state.provider !== params.agentId) return null;
    if (state.configOptions.length === 0) return null;

    const sessionModes = parseAcpSessionModesState(
        readMetadataAliasValue((params.metadata as any) ?? {}, SESSION_MODES_STATE_KEY, LEGACY_ACP_SESSION_MODES_STATE_KEY),
    );
    const hasDedicatedModeControl = sessionModes?.provider === params.agentId && sessionModes.availableModes.length > 0;

    const sessionModels = parseAcpSessionModelsState(
        readMetadataAliasValue((params.metadata as any) ?? {}, SESSION_MODELS_STATE_KEY, LEGACY_ACP_SESSION_MODELS_STATE_KEY),
    );
    const hasDedicatedModelControl =
        sessionModels?.provider === params.agentId && sessionModels.availableModels.length > 0;

    const overrides = parseAcpConfigOptionOverridesState(
        readMetadataAliasValue((params.metadata as any) ?? {}, SESSION_CONFIG_OPTION_OVERRIDES_KEY, LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY),
    );
    return buildAcpConfigOptionControls({
        providerId: params.agentId,
        provider: state.provider,
        configOptions: state.configOptions,
        overrides: overrides?.overrides ?? null,
        hideModeOption: hasDedicatedModeControl,
        hideModelOption: hasDedicatedModelControl,
    });
}

export function computeAcpConfigOptionControlsForProvider(params: Readonly<{
    providerId: string;
    configOptions: ReadonlyArray<AcpConfigOption> | null | undefined;
    overrides?: Readonly<Record<string, Readonly<{ value: unknown }>>> | null;
    hideModeOption?: boolean;
    hideModelOption?: boolean;
}>): AcpConfigOptionControl[] | null {
    if (!Array.isArray(params.configOptions) || params.configOptions.length === 0) return null;
    return buildAcpConfigOptionControls({
        providerId: params.providerId,
        provider: params.providerId,
        configOptions: params.configOptions,
        overrides: params.overrides ?? null,
        hideModeOption: params.hideModeOption ?? false,
        hideModelOption: params.hideModelOption ?? false,
    });
}

export function computeAcpConfigOptionControlsFromOverride(params: Readonly<{
    agentId: AgentId;
    configOptions: ReadonlyArray<AcpConfigOption> | null | undefined;
    overrides?: Readonly<Record<string, Readonly<{ value: unknown }>>> | null;
}>): AcpConfigOptionControl[] | null {
    return computeAcpConfigOptionControlsForProvider({
        providerId: params.agentId,
        configOptions: params.configOptions,
        overrides: params.overrides ?? null,
    });
}
