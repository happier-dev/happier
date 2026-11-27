import type { PluginProjectionEditableSettingField } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { tracking } from '@/track';

import { flushTrackingClient } from './flushTrackingClient';
import type { SettingsAnalyticsPropertyValue } from './types';

type PluginSettingAnalytics = NonNullable<PluginProjectionEditableSettingField['analytics']>;

function hasValue(value: unknown): boolean {
    if (value === null || value === undefined || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
}

function readOrderedEnumValues(
    schema: PluginProjectionEditableSettingField['valueSchema'],
): readonly string[] | null {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
    const items = 'items' in schema ? schema.items : undefined;
    if (!items || typeof items !== 'object' || Array.isArray(items)) return null;
    const values = 'enum' in items ? items.enum : undefined;
    if (!Array.isArray(values) || !values.every((entry): entry is string => typeof entry === 'string')) {
        return null;
    }
    return values;
}

/**
 * Scalars the field itself declares (schema `enum` or presentation options). Plugins are trusted
 * code but their users' values are not ours to collect: only these declared values, booleans,
 * counts and presence ever leave the device, whatever privacy a plugin declares.
 */
function readDeclaredScalarValues(field: PluginProjectionEditableSettingField): ReadonlySet<unknown> | null {
    const schema = field.valueSchema;
    const schemaValues = schema && typeof schema === 'object' && !Array.isArray(schema) && 'enum' in schema
        && Array.isArray(schema.enum) ? schema.enum : [];
    const optionValues = (field.presentation?.options ?? []).map((option) => option.value);
    const declared = [...schemaValues, ...optionValues]
        .filter((value) => typeof value === 'string' || typeof value === 'number');
    return declared.length > 0 ? new Set(declared) : null;
}

/** A field with neither booleans, counts of collections nor declared values reports only whether it is set. */
function isPresenceOnlyField(field: PluginProjectionEditableSettingField): boolean {
    const analytics = field.analytics as PluginSettingAnalytics;
    if (analytics.privacy === 'presence_only' || analytics.serializeCurrentRule === 'jsonObjectStringPresence') return true;
    if (analytics.serializeCurrentRule === 'orderedEnumArrayJoin') return false;
    const declared = readDeclaredScalarValues(field);
    if (analytics.privacy === 'count_only') return field.valueType === 'number' && declared === null;
    return field.valueType !== 'boolean' && declared === null;
}

function serializeValue(
    value: unknown,
    field: PluginProjectionEditableSettingField,
): SettingsAnalyticsPropertyValue | undefined {
    const analytics = field.analytics as PluginSettingAnalytics;
    if (analytics.privacy === 'forbidden') return undefined;
    if (analytics.serializeCurrentRule === 'orderedEnumArrayJoin') {
        if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string')) {
            return undefined;
        }
        const declaredOrder = readOrderedEnumValues(field.valueSchema);
        if (!declaredOrder) return undefined;
        const selected = new Set(value);
        const ordered = declaredOrder.filter((entry) => selected.has(entry));
        return ordered.length === 0 ? 'none' : ordered.join('+');
    }
    if (isPresenceOnlyField(field)) {
        return hasValue(value);
    }
    if (analytics.privacy === 'count_only') {
        if (typeof value === 'number') return readDeclaredScalarValues(field)?.has(value) ? value : undefined;
        if (Array.isArray(value) || typeof value === 'string') return value.length;
        if (value && typeof value === 'object') return Object.keys(value).length;
        return 0;
    }
    if (value === null || typeof value === 'boolean') return value;
    return readDeclaredScalarValues(field)?.has(value) ? value as string | number : undefined;
}

export function emitPluginSettingChangedEvent(params: Readonly<{
    pluginId: string;
    scope: 'account' | 'daemon';
    previousValue: unknown;
    nextValue: unknown;
    field: PluginProjectionEditableSettingField;
}>): void {
    const analytics = params.field.analytics;
    if (!tracking || analytics?.trackChanges !== true) return;

    const previousValue = serializeValue(params.previousValue, params.field);
    const nextValue = serializeValue(params.nextValue, params.field);
    if (previousValue === undefined || nextValue === undefined || Object.is(previousValue, nextValue)) return;
    const defaultValue = params.field.defaultValue === undefined
        ? undefined
        : serializeValue(params.field.defaultValue, params.field);

    tracking.capture('setting_changed', {
        setting_key: `${params.pluginId}/${params.field.key}`,
        scope: params.scope === 'account' ? 'account_setting' : 'local_setting',
        identity_scope: analytics.identityScope,
        value_kind: isPresenceOnlyField(params.field) ? 'presence' : analytics.valueKind,
        prev_value: previousValue,
        next_value: nextValue,
        was_default_before: defaultValue !== undefined && Object.is(previousValue, defaultValue),
        is_default_after: defaultValue !== undefined && Object.is(nextValue, defaultValue),
        source: 'ui',
    });
    flushTrackingClient(tracking);
}
