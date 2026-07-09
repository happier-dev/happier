import type {
    PluginSettingsChangeListenerV1,
    PluginSettingsFieldDescriptorV1,
    PluginSettingsFormFieldV1,
    PluginSettingsFormProjectionV1,
    PluginSettingsServiceV1,
    PluginStorageScopeServiceV1,
    SubscriptionV1,
} from '@happier-dev/plugin-sdk';

import { PluginContextServiceError } from './errors';

const SETTINGS_STORAGE_KEY = 'settings';

export type CreatePluginSettingsServiceParams = Readonly<{
    pluginId: string;
    storage: PluginStorageScopeServiceV1;
    descriptors?: readonly PluginSettingsFieldDescriptorV1[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneSettings(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function compareSettingsFields(left: PluginSettingsFieldDescriptorV1, right: PluginSettingsFieldDescriptorV1): number {
    return (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
        || left.id.localeCompare(right.id);
}

function validateValueForDescriptor(descriptor: PluginSettingsFieldDescriptorV1, value: unknown): void {
    const expectedType = descriptor.valueSchema.type;
    const valid = (() => {
        if (value === null) return expectedType === 'null';
        if (expectedType === 'array') return Array.isArray(value);
        if (expectedType === 'integer') return typeof value === 'number' && Number.isInteger(value);
        if (expectedType === 'object') return isRecord(value);
        return typeof value === expectedType;
    })();

    if (!valid) {
        throw new PluginContextServiceError(
            'PLUGIN_SETTINGS_VALIDATION_FAILED',
            `Plugin setting '${descriptor.id}' failed schema validation`,
        );
    }
    if (descriptor.valueSchema.enum && !descriptor.valueSchema.enum.some((entry) => Object.is(entry, value))) {
        throw new PluginContextServiceError(
            'PLUGIN_SETTINGS_VALIDATION_FAILED',
            `Plugin setting '${descriptor.id}' is not an allowed enum value`,
        );
    }
}

function toFormField(descriptor: PluginSettingsFieldDescriptorV1): PluginSettingsFormFieldV1 {
    return Object.freeze({
        id: descriptor.id,
        kind: descriptor.kind,
        version: descriptor.version,
        valueSchema: descriptor.valueSchema,
        control: descriptor.control,
        displayKey: descriptor.displayKey,
        ...(descriptor.descriptionKey ? { descriptionKey: descriptor.descriptionKey } : {}),
        ...(descriptor.groupId !== undefined ? { groupId: descriptor.groupId } : {}),
        ...(typeof descriptor.order === 'number' ? { order: descriptor.order } : {}),
        capabilityGates: Object.freeze([...(descriptor.capabilityGates ?? [])]),
        permissionGates: Object.freeze([...(descriptor.permissionGates ?? [])]),
        redaction: descriptor.redaction,
        hidden: descriptor.hidden,
        ...(descriptor.defaultValue !== undefined ? { defaultValue: descriptor.defaultValue } : {}),
        ...(descriptor.defaultBooleanValue !== undefined ? { defaultBooleanValue: descriptor.defaultBooleanValue } : {}),
        clearWhenEmpty: descriptor.clearWhenEmpty,
    });
}

export function createPluginSettingsService(params: CreatePluginSettingsServiceParams): PluginSettingsServiceV1 {
    const descriptors = Object.freeze([...(params.descriptors ?? [])].sort(compareSettingsFields));
    const descriptorsById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor] as const));
    const listeners = new Set<PluginSettingsChangeListenerV1>();

    async function readSettings(): Promise<Record<string, unknown>> {
        const stored = await params.storage.get(SETTINGS_STORAGE_KEY);
        return isRecord(stored) ? cloneSettings(stored) : {};
    }

    async function writeSettings(next: Record<string, unknown>): Promise<void> {
        await params.storage.set(SETTINGS_STORAGE_KEY, next);
        const frozen = Object.freeze(cloneSettings(next));
        for (const listener of listeners) {
            listener(frozen);
        }
    }

    return Object.freeze({
        async get<T = unknown>(key?: string): Promise<Readonly<Record<string, unknown>> | T | null> {
            const settings = await readSettings();
            if (key === undefined) {
                return Object.freeze(settings);
            }
            if (Object.prototype.hasOwnProperty.call(settings, key)) {
                return settings[key] as T;
            }
            const descriptor = descriptorsById.get(key);
            if (descriptor?.control === 'switch' && descriptor.defaultBooleanValue !== undefined) {
                return descriptor.defaultBooleanValue as T;
            }
            return null;
        },
        async set(key: string, value: unknown): Promise<void> {
            const descriptor = descriptorsById.get(key);
            if (!descriptor) {
                throw new PluginContextServiceError(
                    'PLUGIN_SETTINGS_UNKNOWN_KEY',
                    `Plugin setting '${key}' is not declared in the manifest`,
                );
            }

            const next = await readSettings();
            const textLike = descriptor.control === 'text'
                || descriptor.control === 'password'
                || descriptor.control === 'textarea';
            if (textLike && value === '' && descriptor.clearWhenEmpty === 'omit') {
                delete next[key];
                await writeSettings(next);
                return;
            }

            validateValueForDescriptor(descriptor, value);
            next[key] = value;
            await writeSettings(next);
        },
        onChange(listener: PluginSettingsChangeListenerV1): SubscriptionV1 {
            listeners.add(listener);
            return Object.freeze({
                unsubscribe: () => {
                    listeners.delete(listener);
                },
            });
        },
        describeFields(): readonly PluginSettingsFieldDescriptorV1[] {
            return Object.freeze([...descriptors]);
        },
        projectForm(): PluginSettingsFormProjectionV1 {
            return Object.freeze({
                storageScope: 'pluginLocal',
                fields: Object.freeze(descriptors
                    .filter((descriptor) => descriptor.hidden !== true)
                    .map(toFormField)),
            });
        },
    }) as PluginSettingsServiceV1;
}
