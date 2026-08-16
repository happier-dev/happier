import {
    computeSessionConfigOptionControlsForProvider,
    type SessionConfigOption,
    type SessionConfigOptionControl,
} from '@/sync/domains/sessionControl/configOptionsControl';

import { collectNewSessionModelScopedOptionIds } from './collectNewSessionModelScopedOptionIds';
import { findModelOptionForEffectiveModelId } from '@/sync/domains/models/modelOptions';
import {
    readNonBlankSessionControlIdentifier,
    readSessionControlValueId,
} from '@/sync/domains/sessionControl/opaqueIdentifiers';

type NewSessionModelOptionWithConfigOptions = Readonly<{
    value: string;
    modelOptions?: ReadonlyArray<SessionConfigOption>;
}>;

function normalizeOverrideValues(
    overrides: Readonly<Record<string, string>> | null | undefined,
): Readonly<Record<string, string>> {
    const normalized: Record<string, string> = {};
    for (const [configId, value] of Object.entries(overrides ?? {})) {
        const normalizedConfigId = readNonBlankSessionControlIdentifier(configId) ?? '';
        const normalizedValue = readSessionControlValueId(value) ?? '';
        if (!normalizedConfigId || !normalizedValue) continue;
        normalized[normalizedConfigId] = normalizedValue;
    }
    return normalized;
}

function toOverrideRecords(overrides: Readonly<Record<string, string>>): Readonly<Record<string, Readonly<{ value: string }>>> {
    return Object.fromEntries(
        Object.entries(overrides).map(([configId, value]) => [configId, { value }]),
    );
}

function controlsByOptionId(
    controls: ReadonlyArray<SessionConfigOptionControl> | null,
): ReadonlyMap<string, SessionConfigOptionControl> {
    const byId = new Map<string, SessionConfigOptionControl>();
    for (const control of controls ?? []) {
        byId.set(control.option.id, control);
    }
    return byId;
}

export function sanitizeNewSessionConfigOverridesForModelSelection(params: Readonly<{
    providerId: string;
    configOptions: ReadonlyArray<SessionConfigOption> | null | undefined;
    modelOptions: ReadonlyArray<NewSessionModelOptionWithConfigOptions>;
    selectedModelId: string;
    selectedConfigOverrides: Readonly<Record<string, string>> | null | undefined;
}>): Readonly<Record<string, string>> {
    const normalizedOverrides = normalizeOverrideValues(params.selectedConfigOverrides);
    const overrideRecords = toOverrideRecords(normalizedOverrides);
    const globalControls = controlsByOptionId(computeSessionConfigOptionControlsForProvider({
        providerId: params.providerId,
        configOptions: params.configOptions,
        overrides: overrideRecords,
        hideModeOption: true,
        hideModelOption: params.modelOptions.length > 0,
    }) ?? null);
    const selectedModel = findModelOptionForEffectiveModelId(params.modelOptions, params.selectedModelId);
    const selectedModelControls = controlsByOptionId(computeSessionConfigOptionControlsForProvider({
        providerId: params.providerId,
        configOptions: selectedModel?.modelOptions ?? null,
        overrides: overrideRecords,
    }) ?? null);
    const modelScopedOptionIds = collectNewSessionModelScopedOptionIds(params.modelOptions);
    const sanitized: Record<string, string> = {};

    for (const [configId, value] of Object.entries(normalizedOverrides)) {
        const globalControl = globalControls.get(configId);
        if (globalControl) {
            if (globalControl.requestedValue !== undefined) {
                sanitized[configId] = globalControl.requestedValue;
            }
            continue;
        }

        const selectedModelControl = selectedModelControls.get(configId);
        if (selectedModelControl) {
            if (selectedModelControl.requestedValue !== undefined) {
                sanitized[configId] = selectedModelControl.requestedValue;
            }
            continue;
        }

        if (modelScopedOptionIds.has(configId)) {
            continue;
        }

        sanitized[configId] = value;
    }

    return sanitized;
}
