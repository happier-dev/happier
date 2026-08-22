import { applySessionStateUpdatesToMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import type { AgentTerminalSessionStateUpdate } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  RuntimeDescriptorV1Schema,
  type SessionMetadata,
} from '@happier-dev/protocol';

function assertPlainRecord(
    value: unknown,
    field: string,
): asserts value is Readonly<Record<string, unknown>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Agent-authored Session state '${field}' must be an object`);
    }
}

function assertOnlyKeys(
    value: Readonly<Record<string, unknown>>,
    allowed: readonly string[],
    field: string,
): void {
    const allowedKeys = new Set(allowed);
    const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
    if (unexpected) {
        throw new Error(`Agent-authored Session state '${field}' contains unsupported property '${unexpected}'`);
    }
}

export function assertAgentAuthoredSessionStateUpdates(
    value: unknown,
    field = 'sessionStateUpdates',
): asserts value is readonly AgentTerminalSessionStateUpdate[] {
    if (!Array.isArray(value)) {
        throw new Error(`Agent-authored Session state '${field}' must be an array`);
    }
    for (const [index, update] of value.entries()) {
        const updateField = `${field}[${index}]`;
        assertPlainRecord(update, updateField);
        assertOnlyKeys(update, ['fieldId', 'value', 'updatedAt'], updateField);
        if (
            update.fieldId !== 'identity.runtimeDescriptor'
            && update.fieldId !== 'identity.providerSessionId'
        ) {
            throw new Error(
                `Agent-authored Session state '${updateField}' contains unsupported field '${String(update.fieldId)}'`,
            );
        }
        if (update.fieldId === 'identity.providerSessionId' && typeof update.value !== 'string') {
            throw new Error(
                `Agent-authored Session state '${updateField}.value' must be a provider Session id string`,
            );
        }
        if (
            update.fieldId === 'identity.runtimeDescriptor'
            && !RuntimeDescriptorV1Schema.safeParse(update.value).success
        ) {
            throw new Error(
                `Agent-authored Session state '${updateField}.value' must be a runtime descriptor`,
            );
        }
        if (update.updatedAt !== undefined && typeof update.updatedAt !== 'number') {
            throw new Error(`Agent-authored Session state '${updateField}.updatedAt' must be a number`);
        }
    }
}

export function applyAgentAuthoredSessionStateUpdatesToMetadata<
    TMetadata extends SessionMetadata,
>(
    metadata: TMetadata,
    updates: unknown,
    field = 'sessionStateUpdates',
): TMetadata {
    assertAgentAuthoredSessionStateUpdates(updates, field);
    return applySessionStateUpdatesToMetadata(metadata, updates);
}
