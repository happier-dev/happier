import type { PluginUiProjectionModel, PluginUiStructuredMessageProjection } from '@/sync/domains/plugins/ui/projection';
import { canRenderPluginUiProjectionEntry } from '@/sync/domains/plugins/ui/policy';

import {
    findStructuredMessageRenderer,
    type StructuredMessageRegistryEntry,
} from './structuredMessageRegistry';
import { renderPluginStructuredMessage } from './rendererAllowlist';

type PluginJsonSchema = Readonly<Record<string, unknown>>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function matchesType(schemaType: unknown, value: unknown): boolean {
    switch (schemaType) {
        case 'object':
            return readRecord(value) !== null;
        case 'array':
            return Array.isArray(value);
        case 'string':
            return typeof value === 'string';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'null':
            return value === null;
        default:
            return true;
    }
}

function matchesPluginJsonSchema(schema: unknown, value: unknown): boolean {
    const record = readRecord(schema);
    if (!record) {
        return true;
    }
    if (!matchesType(record.type, value)) {
        return false;
    }

    if (record.type === 'object') {
        const objectValue = readRecord(value);
        if (!objectValue) return false;
        if (Array.isArray(record.required)) {
            for (const key of record.required) {
                if (typeof key === 'string' && !(key in objectValue)) {
                    return false;
                }
            }
        }
        const properties = readRecord(record.properties);
        if (properties) {
            for (const [key, childSchema] of Object.entries(properties)) {
                if (key in objectValue && !matchesPluginJsonSchema(childSchema as PluginJsonSchema, objectValue[key])) {
                    return false;
                }
            }
        }
    }

    if (record.type === 'array' && Array.isArray(value) && record.items) {
        return value.every((entry) => matchesPluginJsonSchema(record.items, entry));
    }

    if (Array.isArray(record.enum)) {
        return record.enum.some((entry) => Object.is(entry, value));
    }

    return true;
}

function createPluginStructuredMessageEntry(
    descriptor: PluginUiStructuredMessageProjection,
): StructuredMessageRegistryEntry<unknown> {
    return {
        kind: descriptor.kind,
        schema: {
            safeParse(payload: unknown) {
                return matchesPluginJsonSchema(descriptor.payloadSchema, payload)
                    ? { success: true, data: payload }
                    : { success: false, error: new Error('plugin_structured_message_payload_invalid') };
            },
        },
        render: (payload) => renderPluginStructuredMessage({ descriptor, payload }),
    };
}

export function findStructuredMessageDescriptorEntry(params: Readonly<{
    kind: string;
    pluginUiProjection?: PluginUiProjectionModel | null;
}>): StructuredMessageRegistryEntry<unknown> | null {
    const builtIn = findStructuredMessageRenderer(params.kind);
    if (builtIn) {
        return builtIn;
    }

    const descriptor = params.pluginUiProjection?.structuredMessagesByKind[params.kind];
    if (!descriptor) {
        return null;
    }
    if (!canRenderPluginUiProjectionEntry(descriptor)) {
        return null;
    }
    return createPluginStructuredMessageEntry(descriptor);
}
