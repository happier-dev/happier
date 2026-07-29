import type { PluginProjectionEditableSettingField } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { tracking } from '@/track';

import { flushTrackingClient } from './flushTrackingClient';
import type { SettingsAnalyticsPropertyValue } from './types';

type PluginSettingAnalytics = NonNullable<PluginProjectionEditableSettingField['analytics']>;

function isScalar(value: unknown): value is SettingsAnalyticsPropertyValue {
    return value === null
        || typeof value === 'boolean'
        || typeof value === 'number'
        || typeof value === 'string';
}

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
    if (analytics.serializeCurrentRule === 'jsonObjectStringPresence' || analytics.privacy === 'presence_only') {
        return hasValue(value);
    }
    if (analytics.privacy === 'count_only') {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (Array.isArray(value) || typeof value === 'string') return value.length;
        if (value && typeof value === 'object') return Object.keys(value).length;
        return 0;
    }
    return isScalar(value) ? value : undefined;
}

export function emitPluginSettingChangedEvent(params: Readonly<{
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
        setting_key: params.field.key,
        scope: 'account_setting',
        identity_scope: analytics.identityScope,
        value_kind: analytics.valueKind,
        prev_value: previousValue,
        next_value: nextValue,
        was_default_before: defaultValue !== undefined && Object.is(previousValue, defaultValue),
        is_default_after: defaultValue !== undefined && Object.is(nextValue, defaultValue),
        source: 'ui',
    });
    flushTrackingClient(tracking);
}
