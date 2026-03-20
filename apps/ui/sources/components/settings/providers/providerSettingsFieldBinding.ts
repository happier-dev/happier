import type { ProviderSettingFieldDef } from '@/agents/providers/shared/providerSettingsPlugin';

type SettingsRecord = Readonly<Record<string, unknown>>;

function readStringRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

    return Object.fromEntries(
        Object.entries(value).flatMap(([key, entryValue]) => {
            if (typeof key !== 'string' || key.trim().length === 0) return [];
            if (typeof entryValue !== 'string') return [];
            return [[key, entryValue]];
        }),
    );
}

export function readProviderSettingsFieldValue(args: Readonly<{
    field: ProviderSettingFieldDef;
    settings: SettingsRecord;
    activeServerId: string | null;
}>): unknown {
    const binding = args.field.binding;
    if (!binding || binding.kind === 'direct') {
        const settingKey = binding?.settingKey ?? args.field.key;
        return args.settings[settingKey];
    }

    const perServerValues = readStringRecord(args.settings[binding.byServerIdSettingKey]);
    if (args.activeServerId) {
        const scopedValue = perServerValues[args.activeServerId];
        if (typeof scopedValue === 'string') return scopedValue;
    }

    return args.settings[binding.fallbackSettingKey];
}

export function buildProviderSettingsFieldPatch(args: Readonly<{
    field: ProviderSettingFieldDef;
    value: unknown;
    settings: SettingsRecord;
    activeServerId: string | null;
}>): Record<string, unknown> {
    const binding = args.field.binding;
    if (!binding || binding.kind === 'direct') {
        const settingKey = binding?.settingKey ?? args.field.key;
        return { [settingKey]: args.value };
    }

    if (!args.activeServerId) {
        return { [binding.fallbackSettingKey]: args.value };
    }

    const nextByServerId = readStringRecord(args.settings[binding.byServerIdSettingKey]);
    const normalizedValue = typeof args.value === 'string' ? args.value : '';

    if (normalizedValue.trim().length === 0) {
        delete nextByServerId[args.activeServerId];
    } else {
        nextByServerId[args.activeServerId] = normalizedValue;
    }

    return {
        [binding.byServerIdSettingKey]: nextByServerId,
    };
}
