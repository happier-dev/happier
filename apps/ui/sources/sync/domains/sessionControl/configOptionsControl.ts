import type { AgentId } from '@/agents/catalog/catalog';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import {
    LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY,
    LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
    LEGACY_ACP_SESSION_MODELS_STATE_KEY,
    LEGACY_ACP_SESSION_MODES_STATE_KEY,
    readAcpConfigOptionIntentFromMetadata,
    readMetadataAliasValue,
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_CONFIG_OPTION_OVERRIDES_KEY,
    SESSION_MODELS_STATE_KEY,
    SESSION_MODES_STATE_KEY,
} from '@happier-dev/agents';

import {
    parseSessionConfigOptionsState,
    parseSessionConfigOptionOverridesState,
    parseSessionModelsState,
    parseSessionModesState,
} from './schema';

export type SessionConfigOptionValueId = string;

function normalizeValueId(raw: unknown): SessionConfigOptionValueId | null {
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof raw === 'boolean') return raw ? 'true' : 'false';
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    return null;
}

export type SessionConfigOptionSelectOption = Readonly<{
    value: SessionConfigOptionValueId;
    name: string;
    description?: string;
}>;

export type SessionConfigOption = Readonly<{
    id: string;
    name: string;
    description?: string;
    type: string;
    currentValue: SessionConfigOptionValueId;
    options?: readonly SessionConfigOptionSelectOption[];
}>;

export type SessionConfigOptionControl = Readonly<{
    option: SessionConfigOption;
    requestedValue?: SessionConfigOptionValueId;
    effectiveValue: SessionConfigOptionValueId;
    isPending: boolean;
    /** Set when another effectively-on boolean option overrides this one (e.g. ultracode). */
    disabled?: boolean;
    disabledByOptionName?: string;
}>;

// Generic overriding-boolean rule: while the keyed boolean option is effectively ON, the
// listed target option ids are rendered disabled ("Overridden by …"). Ultracode overrides
// the Thinking effort level while enabled.
const OVERRIDING_BOOLEAN_OPTION_TARGETS: Readonly<Record<string, readonly string[]>> = {
    ultracode: ['reasoning_effort', 'effort'],
};

function applyOverridingBooleanOptionDimming(
    controls: SessionConfigOptionControl[],
): SessionConfigOptionControl[] {
    const overriddenBy = new Map<string, string>();
    for (const control of controls) {
        const targets = OVERRIDING_BOOLEAN_OPTION_TARGETS[control.option.id];
        if (!targets || !isBooleanConfigOptionType(control.option.type)) continue;
        if (!resolveBooleanConfigOptionValue(control.option, control.effectiveValue)) continue;
        for (const target of targets) {
            overriddenBy.set(target, control.option.name);
        }
    }
    if (overriddenBy.size === 0) return controls;
    return controls.map((control) => {
        const byName = overriddenBy.get(control.option.id);
        return byName
            ? { ...control, disabled: true, disabledByOptionName: byName }
            : control;
    });
}

function resolveRequestedValue(
    option: SessionConfigOption,
    rawValue: unknown,
): SessionConfigOptionValueId | undefined {
    const requestedValue = normalizeValueId(rawValue);
    if (!requestedValue) return undefined;
    if (option.options?.length) {
        return option.options.some((entry) => entry.value === requestedValue)
            ? requestedValue
            : undefined;
    }
    return requestedValue;
}

export function normalizeAcpConfigOptionsArray(raw: unknown): SessionConfigOption[] | null {
    if (!Array.isArray(raw) || raw.length === 0) return null;

    const parsed: SessionConfigOption[] = [];
    type RawConfigOptionChoice = Record<string, unknown>;
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const rec = entry as Record<string, unknown>;
        const id = typeof rec.id === 'string' ? rec.id.trim() : '';
        const name = typeof rec.name === 'string' ? rec.name.trim() : '';
        const type = typeof rec.type === 'string' ? rec.type.trim() : '';
        if (!id || !name || !type) continue;

        const currentValue = normalizeValueId(rec.currentValue);
        if (!currentValue) continue;

        const options = Array.isArray(rec.options)
            ? rec.options
                .filter((option: unknown): option is RawConfigOptionChoice =>
                    Boolean(option && typeof option === 'object' && !Array.isArray(option))
                )
                .map((option: RawConfigOptionChoice) => {
                    const value = normalizeValueId(option.value);
                    const optionName = typeof option.name === 'string' ? option.name.trim() : '';
                    if (!value || !optionName) return null;
                    const description = typeof option.description === 'string' ? option.description.trim() : '';
                    return { value, name: optionName, ...(description ? { description } : {}) };
                })
                .filter(
                    (option: NonNullable<SessionConfigOption['options']>[number] | null): option is NonNullable<SessionConfigOption['options']>[number] =>
                        option !== null
                )
            : undefined;

        const description = typeof rec.description === 'string' ? rec.description.trim() : '';
        parsed.push({
            id,
            name,
            type,
            currentValue,
            ...(description ? { description } : {}),
            ...(options && options.length > 0 ? { options } : {}),
        } satisfies SessionConfigOption);
    }

    return parsed.length > 0 ? parsed : null;
}

export function isBooleanConfigOptionType(type: string): boolean {
    return type === 'boolean' || type === 'bool' || type === 'toggle';
}

export function resolveBooleanConfigOptionToggleValues(option: SessionConfigOption): Readonly<{
    offValue: SessionConfigOptionValueId;
    onValue: SessionConfigOptionValueId;
}> {
    const optionValues = Array.isArray(option.options)
        ? option.options
            .map((entry) => normalizeValueId(entry.value))
            .filter((value): value is SessionConfigOptionValueId => value !== null)
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

export function resolveBooleanConfigOptionValue(option: SessionConfigOption, value: SessionConfigOptionValueId): boolean {
    const { onValue } = resolveBooleanConfigOptionToggleValues(option);
    return value === onValue;
}

export function resolveBooleanConfigOptionNextValue(option: SessionConfigOption, enabled: boolean): SessionConfigOptionValueId {
    const { offValue, onValue } = resolveBooleanConfigOptionToggleValues(option);
    return enabled ? onValue : offValue;
}

function buildSessionConfigOptionControls(params: Readonly<{
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
}>): SessionConfigOptionControl[] | null {
    if (params.provider !== params.providerId) return null;

    const controls: SessionConfigOptionControl[] = [];

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
            .filter((value): value is SessionConfigOptionSelectOption => value !== null);

        const description = typeof entry.description === 'string' ? entry.description.trim() : '';
        const option: SessionConfigOption = {
            id,
            name,
            type,
            currentValue,
            ...(description ? { description } : {}),
            ...(options.length > 0 ? { options } : {}),
        };

        const requestedValue = resolveRequestedValue(option, params.overrides?.[id]?.value);
        const effectiveValue = requestedValue ?? currentValue;
        const isPending = requestedValue !== undefined && requestedValue !== currentValue;

        controls.push({
            option,
            ...(requestedValue !== undefined ? { requestedValue } : {}),
            effectiveValue,
            isPending,
        });
    }

    return controls.length > 0 ? applyOverridingBooleanOptionDimming(controls) : null;
}

export function computeSessionConfigOptionControls(params: {
    agentId: AgentId;
    metadata: Metadata | null | undefined;
}): SessionConfigOptionControl[] | null {
    const state = parseSessionConfigOptionsState(
        readMetadataAliasValue((params.metadata as any) ?? {}, SESSION_CONFIG_OPTIONS_STATE_KEY, LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY),
    );
    if (!state) return null;
    if (state.provider !== params.agentId) return null;
    if (state.configOptions.length === 0) return null;

    const sessionModes = parseSessionModesState(
        readMetadataAliasValue((params.metadata as any) ?? {}, SESSION_MODES_STATE_KEY, LEGACY_ACP_SESSION_MODES_STATE_KEY),
    );
    const hasDedicatedModeControl = sessionModes?.provider === params.agentId && sessionModes.availableModes.length > 0;

    const sessionModels = parseSessionModelsState(
        readMetadataAliasValue((params.metadata as any) ?? {}, SESSION_MODELS_STATE_KEY, LEGACY_ACP_SESSION_MODELS_STATE_KEY),
    );
    const hasDedicatedModelControl =
        sessionModels?.provider === params.agentId && sessionModels.availableModels.length > 0;

    const metadataRecord = (params.metadata as any) ?? {};
    const parsedOverrides = parseSessionConfigOptionOverridesState(
        readMetadataAliasValue(metadataRecord, SESSION_CONFIG_OPTION_OVERRIDES_KEY, LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY),
    );
    const overrides: Record<string, Readonly<{ value: unknown }>> = { ...(parsedOverrides?.overrides ?? {}) };
    for (const option of state.configOptions) {
        const optionId = typeof option.id === 'string' ? option.id.trim() : '';
        if (!optionId) continue;
        const intent = readAcpConfigOptionIntentFromMetadata(metadataRecord, optionId);
        if (intent) {
            overrides[optionId] = { value: intent.value };
        }
    }
    return buildSessionConfigOptionControls({
        providerId: params.agentId,
        provider: state.provider,
        configOptions: state.configOptions,
        overrides,
        hideModeOption: hasDedicatedModeControl,
        hideModelOption: hasDedicatedModelControl,
    });
}

export function computeSessionConfigOptionControlsForProvider(params: Readonly<{
    providerId: string;
    configOptions: ReadonlyArray<SessionConfigOption> | null | undefined;
    overrides?: Readonly<Record<string, Readonly<{ value: unknown }>>> | null;
    hideModeOption?: boolean;
    hideModelOption?: boolean;
}>): SessionConfigOptionControl[] | null {
    if (!Array.isArray(params.configOptions) || params.configOptions.length === 0) return null;
    return buildSessionConfigOptionControls({
        providerId: params.providerId,
        provider: params.providerId,
        configOptions: params.configOptions,
        overrides: params.overrides ?? null,
        hideModeOption: params.hideModeOption ?? false,
        hideModelOption: params.hideModelOption ?? false,
    });
}

export function computeSessionConfigOptionControlsFromOverride(params: Readonly<{
    agentId: AgentId;
    configOptions: ReadonlyArray<SessionConfigOption> | null | undefined;
    overrides?: Readonly<Record<string, Readonly<{ value: unknown }>>> | null;
}>): SessionConfigOptionControl[] | null {
    return computeSessionConfigOptionControlsForProvider({
        providerId: params.agentId,
        configOptions: params.configOptions,
        overrides: params.overrides ?? null,
    });
}

export type AcpConfigOptionValueId = SessionConfigOptionValueId;
export type AcpConfigOptionSelectOption = SessionConfigOptionSelectOption;
export type AcpConfigOption = SessionConfigOption;
export type AcpConfigOptionControl = SessionConfigOptionControl;

export const computeAcpConfigOptionControls = computeSessionConfigOptionControls;
export const computeAcpConfigOptionControlsForProvider = computeSessionConfigOptionControlsForProvider;
export const computeAcpConfigOptionControlsFromOverride = computeSessionConfigOptionControlsFromOverride;
