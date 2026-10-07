import { SessionSystemRecordStoredSchema, type SessionSystemRecordStored } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { openSessionStoredContent, type SessionStoredContentContext } from '@happier-dev/sync-client';
import type { HostSessionSystemRecordAddress } from './transport';

export type SessionSystemRecordPayloadResult<T> =
    | Readonly<{ status: 'ready'; value: T }>
    | Readonly<{ status: 'malformed' }>
    | Readonly<{ status: 'unsupported_version'; version: unknown }>;
export type OpenSessionSystemRecordResult<T> = SessionSystemRecordPayloadResult<T>
    | Readonly<{ status: 'locked' | 'corrupt_or_unopenable' | 'mode_mismatch' }>;

/**
 * Revisionless predecessor rows are normalized only by the compatibility seam.
 * Current consumers still use this exact-address opener and never parse a legacy
 * wire shape or open raw content themselves.
 */
export type SessionSystemRecordCompatibilityOpenInput = Readonly<{
    source: 'legacy-host-compatibility';
    address: HostSessionSystemRecordAddress;
    content: unknown;
}>;
export type SessionSystemRecordOpenInput = SessionSystemRecordStored | SessionSystemRecordCompatibilityOpenInput;

/** Payload schemas and version recognition belong to the consuming record domain. */
async function openSessionSystemRecordPayload<T>(params: Readonly<{
    content: unknown;
    context: SessionStoredContentContext | null;
    decode: (payload: unknown) => SessionSystemRecordPayloadResult<T>;
}>): Promise<OpenSessionSystemRecordResult<T>> {
    const opened = await openSessionStoredContent(params.context, params.content);
    return opened.status === 'ready' ? params.decode(opened.value) : opened;
}

export async function openSessionSystemRecord<T>(params: Readonly<{
    record: SessionSystemRecordOpenInput | unknown;
    address: HostSessionSystemRecordAddress;
    context: SessionStoredContentContext | null;
    decode: (payload: unknown) => SessionSystemRecordPayloadResult<T>;
}>): Promise<OpenSessionSystemRecordResult<T>> {
    const compatibility = params.record
        && typeof params.record === 'object'
        && 'source' in params.record
        && params.record.source === 'legacy-host-compatibility'
        ? params.record as SessionSystemRecordCompatibilityOpenInput
        : null;
    let address: HostSessionSystemRecordAddress;
    let content: unknown;
    if (compatibility) {
        address = compatibility.address;
        content = compatibility.content;
    } else {
        const parsed = SessionSystemRecordStoredSchema.safeParse(params.record);
        if (!parsed.success || parsed.data.address.owner !== 'host') return { status: 'malformed' };
        address = parsed.data.address;
        content = parsed.data.content;
    }
    if (address.owner !== 'host' || address.namespace !== params.address.namespace || address.kind !== params.address.kind || address.localId !== params.address.localId) return { status: 'malformed' };
    return await openSessionSystemRecordPayload({ content, context: params.context, decode: params.decode });
}
