import type {
    PluginConfigurationSettingFieldV2,
    PluginJsonValueV2,
} from '@happier-dev/protocol';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol';

export type ConnectedAccountConfigurationControl =
    | 'text'
    | 'textarea'
    | 'switch'
    | 'select'
    | 'multiSelect'
    | 'number'
    | 'json';

export type ConnectedAccountConfigurationDraft = Readonly<Record<string, unknown>>;
export type ConnectedAccountConfigurationOption = Readonly<{
    value: PluginJsonValueV2;
    title: string | Readonly<{ key: string; fallback: string }>;
    description?: string | Readonly<{ key: string; fallback: string }>;
}>;

export type ConnectedAccountConfigurationSubmission =
    | Readonly<{
        ok: true;
        values: Readonly<Record<string, PluginJsonValueV2>>;
        secretValues: Readonly<Record<string, string>>;
    }>
    | Readonly<{
        ok: false;
        missingFieldIds: readonly string[];
        invalidFieldIds: readonly string[];
    }>;

function enumOptionTitle(value: PluginJsonValueV2): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

export function listConnectedAccountConfigurationOptions(
    field: PluginConfigurationSettingFieldV2,
): readonly ConnectedAccountConfigurationOption[] {
    if (field.presentation?.options) return field.presentation.options;
    const enumValues = field.schema.type === 'array'
        ? field.schema.items?.enum
        : field.schema.enum;
    if (!enumValues) return [];
    const options: ConnectedAccountConfigurationOption[] = [];
    for (const value of enumValues) {
        const parsed = PluginJsonValueV2Schema.safeParse(value);
        if (!parsed.success) continue;
        options.push({
            value: parsed.data,
            title: enumOptionTitle(parsed.data),
        });
    }
    return options;
}

export function resolveConnectedAccountConfigurationControl(
    field: PluginConfigurationSettingFieldV2,
): ConnectedAccountConfigurationControl {
    const declared = field.presentation?.control;
    if (declared && declared !== 'auto') return declared;
    if (field.schema.type === 'boolean') return 'switch';
    if (listConnectedAccountConfigurationOptions(field).length > 0) {
        return field.schema.type === 'array' ? 'multiSelect' : 'select';
    }
    if (field.schema.type === 'number' || field.schema.type === 'integer') return 'number';
    if (
        field.schema.type === 'object'
        || field.schema.type === 'array'
        || field.schema.type === 'null'
    ) {
        return 'json';
    }
    return 'text';
}

function stringifyJsonValue(value: PluginJsonValueV2): string {
    return JSON.stringify(value, null, 2);
}

export function createConnectedAccountConfigurationDraft(params: Readonly<{
    fields: readonly PluginConfigurationSettingFieldV2[];
    values: Readonly<Record<string, PluginJsonValueV2>>;
}>): ConnectedAccountConfigurationDraft {
    const draft: Record<string, unknown> = {};
    for (const field of params.fields) {
        if (field.secret === true) {
            draft[field.id] = '';
            continue;
        }
        const value = params.values[field.id] ?? field.default;
        const control = resolveConnectedAccountConfigurationControl(field);
        if (control === 'switch') {
            draft[field.id] = value === true;
        } else if (control === 'number') {
            draft[field.id] = typeof value === 'number' ? String(value) : '';
        } else if (control === 'json') {
            draft[field.id] = value === undefined ? '' : stringifyJsonValue(value);
        } else if (control === 'select' || control === 'multiSelect') {
            draft[field.id] = value;
        } else {
            draft[field.id] = typeof value === 'string' ? value : '';
        }
    }
    return draft;
}

function parseNonSecretField(
    field: PluginConfigurationSettingFieldV2,
    draftValue: unknown,
): Readonly<{ kind: 'value'; value: PluginJsonValueV2 }>
    | Readonly<{ kind: 'missing' }>
    | Readonly<{ kind: 'invalid' }>
    | Readonly<{ kind: 'omitted' }> {
    const control = resolveConnectedAccountConfigurationControl(field);
    if (control === 'switch') {
        return typeof draftValue === 'boolean'
            ? { kind: 'value', value: draftValue }
            : { kind: 'invalid' };
    }
    if (control === 'select' || control === 'multiSelect') {
        if (draftValue === undefined) {
            return field.required === true ? { kind: 'missing' } : { kind: 'omitted' };
        }
        return { kind: 'value', value: draftValue as PluginJsonValueV2 };
    }
    if (typeof draftValue !== 'string') return { kind: 'invalid' };
    if (draftValue.length === 0) {
        return field.required === true ? { kind: 'missing' } : { kind: 'omitted' };
    }
    if (control === 'number') {
        const value = Number(draftValue);
        if (
            !Number.isFinite(value)
            || (field.schema.type === 'integer' && !Number.isInteger(value))
        ) {
            return { kind: 'invalid' };
        }
        return { kind: 'value', value };
    }
    if (control === 'json') {
        try {
            return { kind: 'value', value: JSON.parse(draftValue) as PluginJsonValueV2 };
        } catch {
            return { kind: 'invalid' };
        }
    }
    return { kind: 'value', value: draftValue };
}

export function buildConnectedAccountConfigurationSubmission(params: Readonly<{
    fields: readonly PluginConfigurationSettingFieldV2[];
    draft: ConnectedAccountConfigurationDraft;
    configuredSecretFieldIds: readonly string[];
}>): ConnectedAccountConfigurationSubmission {
    const configuredSecretFieldIds = new Set(params.configuredSecretFieldIds);
    const values: Record<string, PluginJsonValueV2> = {};
    const secretValues: Record<string, string> = {};
    const missingFieldIds: string[] = [];
    const invalidFieldIds: string[] = [];

    for (const field of params.fields) {
        const draftValue = params.draft[field.id];
        if (field.secret === true) {
            if (typeof draftValue !== 'string') {
                invalidFieldIds.push(field.id);
            } else if (draftValue.length > 0) {
                secretValues[field.id] = draftValue;
            } else if (field.required === true && !configuredSecretFieldIds.has(field.id)) {
                missingFieldIds.push(field.id);
            }
            continue;
        }
        const parsed = parseNonSecretField(field, draftValue);
        if (parsed.kind === 'value') values[field.id] = parsed.value;
        else if (parsed.kind === 'missing') missingFieldIds.push(field.id);
        else if (parsed.kind === 'invalid') invalidFieldIds.push(field.id);
    }

    if (missingFieldIds.length > 0 || invalidFieldIds.length > 0) {
        return {
            ok: false,
            missingFieldIds: missingFieldIds.sort(),
            invalidFieldIds: invalidFieldIds.sort(),
        };
    }
    return { ok: true, values, secretValues };
}
