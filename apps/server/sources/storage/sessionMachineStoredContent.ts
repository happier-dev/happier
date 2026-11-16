import { decodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import type { Prisma } from '@prisma/client';
import { decodeStoredText, encodeStoredText } from './storedContent';

/** Byte siblings are storage details; callers continue using their selected text fields. */
function withContentSelect<T extends object>(select: T, stateField: 'agentState' | 'daemonState'): T {
    const selected = select as Record<string, unknown>;
    return {
        ...select,
        ...(selected.metadata === true ? { metadataBytes: true } : {}),
        ...(selected[stateField] === true ? { [stateField + 'Bytes']: true } : {}),
    };
}

export function withSessionContentSelect<T extends Prisma.SessionSelect>(select: T): T {
    return withContentSelect(select, 'agentState');
}

export function withMachineContentSelect<T extends Prisma.MachineSelect>(select: T): T {
    return withContentSelect(select, 'daemonState');
}

function decodeContentResult<T>(result: T, stateField: 'agentState' | 'daemonState'): T {
    if (Array.isArray(result)) return result.map(row => decodeContentResult(row, stateField)) as T;
    if (result === null || typeof result !== 'object') return result;
    const row = result as Record<string, unknown>;
    if (!('metadataBytes' in row) && !(stateField + 'Bytes' in row)) return result;
    const decoded = { ...row };
    for (const field of ['metadata', stateField]) {
        const value = row[field];
        const bytes = row[field + 'Bytes'];
        if ((typeof value === 'string' || value === null) && (bytes === undefined || bytes === null || bytes instanceof Uint8Array)) {
            decoded[field] = decodeStoredText(value, bytes);
        }
        delete decoded[field + 'Bytes'];
    }
    // This projection preserves the query's domain type and removes physical byte siblings.
    return decoded as T;
}

export function decodeSessionStoredContent<T>(result: T): T {
    return decodeContentResult(result, 'agentState');
}

export function decodeMachineStoredContent<T>(result: T): T {
    return decodeContentResult(result, 'daemonState');
}

function encodeContentData<T extends object>(data: T, stateField: 'agentState' | 'daemonState'): T {
    const values = data as Record<string, unknown>;
    const encoded = { ...data } as Record<string, unknown>;
    for (const field of ['metadata', stateField]) {
        const value = values[field];
        if (typeof value !== 'string' && value !== null) continue;
        if (stateField === 'daemonState' && typeof value === 'string') {
            try {
                decodePlainMachineStoredContent(value);
                encoded[field + 'Bytes'] = null;
                continue;
            } catch { /* Opaque encrypted content is handled by the shared physical codec. */ }
        }
        const stored = encodeStoredText(value);
        encoded[field] = stored.value;
        encoded[field + 'Bytes'] = stored.bytes;
    }
    return encoded as T;
}

export function encodeSessionStoredContent<T extends { metadata?: string; agentState?: string | null }>(data: T): T {
    return encodeContentData(data, 'agentState');
}

export function encodeMachineStoredContent<T extends { metadata?: string; daemonState?: string | null }>(data: T): T {
    return encodeContentData(data, 'daemonState');
}

/** A source tuple may still use legacy text; compare its exact accepted representation. */
export function sessionStoredContentWhere(input: Readonly<{ metadata: string; agentState: string | null }>): Prisma.SessionWhereInput {
    return { AND: Object.entries(input).map(([field, value]) => {
        const stored = encodeStoredText(value);
        const legacy = { [field]: value, [field + 'Bytes']: null };
        return stored.bytes === null ? legacy : { OR: [legacy, { [field]: stored.value, [field + 'Bytes']: stored.bytes }] };
    }) };
}
