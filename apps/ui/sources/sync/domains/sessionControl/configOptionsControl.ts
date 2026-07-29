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
        return raw.trim().length > 0 ? raw : null;
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

function hasDuplicateConfigOptionValues(options: readonly SessionConfigOptionSelectOption[]): boolean {
    const values = new Set<string>();
    return options.some((option) => {
        if (values.has(option.value)) return true;
        values.add(option.value);
        return false;
    });
}

export type SessionConfigOptionSelectGroup = Readonly<{
    id: string;
    name: string;
    options: readonly SessionConfigOptionSelectOption[];
}>;

export type SessionConfigOption = Readonly<{
    id: string;
    name: string;
    description?: string;
    type: string;
    currentValue: SessionConfigOptionValueId;
    options?: readonly SessionConfigOptionSelectOption[];
    groups?: readonly SessionConfigOptionSelectGroup[];
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
    const choices = option.options ?? option.groups?.flatMap((group) => group.options);
    if (choices?.length) {
        return choices.some((entry) => entry.value === requestedValue)
            ? requestedValue
            : undefined;
    }
    return requestedValue;
}

export function normalizeAcpConfigOptionsArray(raw: unknown): SessionConfigOption[] | null {
    if (!Array.isArray(raw)) return null;
    if (raw.length === 0) return [];

    const parsed: SessionConfigOption[] = [];
    type RawConfigOptionChoice = Record<string, unknown>;
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const rec = entry as Record<string, unknown>;
        const id = typeof rec.id === 'string' && rec.id.trim().length > 0 ? rec.id : '';
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

        const groups: SessionConfigOptionSelectGroup[] | undefined = Array.isArray(rec.groups)
            ? rec.groups.map((group: unknown): SessionConfigOptionSelectGroup | null => {
                if (!group || typeof group !== 'object' || Array.isArray(group)) return null;
                const groupRecord = group as Record<string, unknown>;
                const groupId = typeof groupRecord.id === 'string' && groupRecord.id.trim().length > 0 ? groupRecord.id : '';
                const groupName = typeof groupRecord.name === 'string' ? groupRecord.name.trim() : '';
                if (!groupId || !groupName || !Array.isArray(groupRecord.options)) return null;
                const groupOptions: SessionConfigOptionSelectOption[] = groupRecord.options.map((choice: unknown): SessionConfigOptionSelectOption | null => {
                    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return null;
                    const choiceRecord = choice as RawConfigOptionChoice;
                    const value = normalizeValueId(choiceRecord.value);
                    const choiceName = typeof choiceRecord.name === 'string' ? choiceRecord.name.trim() : '';
                    if (!value || !choiceName) return null;
                    const choiceDescription = typeof choiceRecord.description === 'string' ? choiceRecord.description.trim() : '';
                    return { value, name: choiceName, ...(choiceDescription ? { description: choiceDescription } : {}) };
                }).filter((choice: SessionConfigOptionSelectOption | null): choice is SessionConfigOptionSelectOption => choice !== null);
                return groupOptions.length > 0 ? { id: groupId, name: groupName, options: groupOptions } : null;
            }).filter((group): group is SessionConfigOptionSelectGroup => group !== null)
            : undefined;

        const description = typeof rec.description === 'string' ? rec.description.trim() : '';
        parsed.push({
            id,
            name,
            type,
            currentValue,
            ...(description ? { description } : {}),
            ...(options && options.length > 0 ? { options } : {}),
            ...(groups && groups.length > 0 ? { groups } : {}),
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
    agentId: string;
    stateAgentId: string | null;
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
        groups?: ReadonlyArray<{
            id: string;
            name: string;
            options: ReadonlyArray<{
                value: unknown;
                name: string;
                description?: string;
            }>;
        }>;
    }>;
    overrides?: Readonly<Record<string, Readonly<{ value: unknown }>>> | null;
    hideModeOption: boolean;
    hideModelOption: boolean;
}>): SessionConfigOptionControl[] | null {
    if (params.stateAgentId !== params.agentId) return null;

    const controls: SessionConfigOptionControl[] = [];
    const idCounts = new Map<string, number>();
    for (const entry of params.configOptions) {
        if (typeof entry.id === 'string' && entry.id.trim().length > 0) {
            idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
        }
    }

    for (const entry of params.configOptions) {
        const id = entry.id;
        const name = entry.name.trim();
        const type = entry.type.trim();
        if (!id || !name || !type || idCounts.get(id) !== 1) continue;

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

        const groups: SessionConfigOptionSelectGroup[] = Array.isArray(entry.groups)
            ? entry.groups.map((group): SessionConfigOptionSelectGroup | null => {
                const groupId = group.id;
                const groupName = group.name.trim();
                const groupOptions: SessionConfigOptionSelectOption[] = group.options.map((choice: Readonly<{
                    value: unknown;
                    name: string;
                    description?: string;
                }>): SessionConfigOptionSelectOption | null => {
                    const value = normalizeValueId(choice.value);
                    const choiceName = choice.name.trim();
                    if (!value || !choiceName) return null;
                    const choiceDescription = typeof choice.description === 'string' ? choice.description.trim() : '';
                    return { value, name: choiceName, ...(choiceDescription ? { description: choiceDescription } : {}) };
                }).filter((choice: SessionConfigOptionSelectOption | null): choice is SessionConfigOptionSelectOption => choice !== null);
                return groupId && groupName && groupOptions.length > 0
                    ? { id: groupId, name: groupName, options: groupOptions }
                    : null;
            }).filter((group): group is SessionConfigOptionSelectGroup => group !== null)
            : [];

        if (options.length > 0 && groups.length > 0) continue;
        if (new Set(groups.map((group) => group.id)).size !== groups.length) continue;
        const choices = options.length > 0 ? options : groups.flatMap((group) => group.options);
        if (hasDuplicateConfigOptionValues(choices)) continue;

        const description = typeof entry.description === 'string' ? entry.description.trim() : '';
        const option: SessionConfigOption = {
            id,
            name,
            type,
            currentValue,
            ...(description ? { description } : {}),
            ...(options.length > 0 ? { options } : {}),
            ...(groups.length > 0 ? { groups } : {}),
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
    if (state.agentId !== params.agentId) return null;
    if (state.configOptions.length === 0) return null;

    const sessionModes = parseSessionModesState(
        readMetadataAliasValue((params.metadata as any) ?? {}, SESSION_MODES_STATE_KEY, LEGACY_ACP_SESSION_MODES_STATE_KEY),
    );
    const hasDedicatedModeControl = sessionModes?.agentId === params.agentId && sessionModes.availableModes.length > 0;

    const sessionModels = parseSessionModelsState(
        readMetadataAliasValue((params.metadata as any) ?? {}, SESSION_MODELS_STATE_KEY, LEGACY_ACP_SESSION_MODELS_STATE_KEY),
    );
    const hasDedicatedModelControl =
        sessionModels?.agentId === params.agentId && sessionModels.availableModels.length > 0;

    const metadataRecord = (params.metadata as any) ?? {};
    const parsedOverrides = parseSessionConfigOptionOverridesState(
        readMetadataAliasValue(metadataRecord, SESSION_CONFIG_OPTION_OVERRIDES_KEY, LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY),
    );
    const overrides: Record<string, Readonly<{ value: unknown }>> = { ...(parsedOverrides?.overrides ?? {}) };
    for (const option of state.configOptions) {
        const optionId = typeof option.id === 'string' && option.id.trim().length > 0 ? option.id : '';
        if (!optionId) continue;
        const intent = readAcpConfigOptionIntentFromMetadata(metadataRecord, optionId);
        if (intent) {
            overrides[optionId] = { value: intent.value };
        }
    }
    return buildSessionConfigOptionControls({
        agentId: params.agentId,
        stateAgentId: state.agentId,
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
        agentId: params.providerId,
        stateAgentId: params.providerId,
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
