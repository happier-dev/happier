import {
    SYNCED_SESSION_AUTHORING_FIELD_IDS_V1,
    SyncedSessionAuthoringValueV1Schema,
    type SyncedSessionAuthoringFieldIdV1,
    type SyncedSessionAuthoringValueV1,
} from '@happier-dev/protocol';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Projects the safe synchronized subset through the protocol field catalog.
 * Fields are parsed independently so one malformed optional selection cannot
 * discard otherwise recoverable authoring intent.
 */
export function projectSyncedSessionAuthoringFields(value: unknown): Partial<SyncedSessionAuthoringValueV1> {
    if (!isRecord(value)) return {};

    const projected: Partial<Record<SyncedSessionAuthoringFieldIdV1, unknown>> = {};
    for (const fieldId of SYNCED_SESSION_AUTHORING_FIELD_IDS_V1) {
        if (!Object.prototype.hasOwnProperty.call(value, fieldId)) continue;
        const parsed = SyncedSessionAuthoringValueV1Schema.shape[fieldId].safeParse(value[fieldId]);
        if (parsed.success) {
            projected[fieldId] = parsed.data;
        }
    }
    return projected as Partial<SyncedSessionAuthoringValueV1>;
}
