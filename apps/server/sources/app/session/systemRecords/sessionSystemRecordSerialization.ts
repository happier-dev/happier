import type { SessionSystemRecordRow } from "./sessionSystemRecordService";

/** Shared by ordinary record replies and component-level batch refusals. */
export function sessionSystemRecordV1ErrorStatus(code: string): 400 | 403 | 404 | 409 | 500 | 503 {
    if (code === 'plugin_session_records_unavailable') return 503;
    if (code === 'plugin_session_record_feature_disabled' || code === 'plugin_session_not_found') return 404;
    if (code === 'plugin_session_record_invalid_query') return 400;
    if (code === 'plugin_session_record_forbidden') return 403;
    if (code === 'plugin_session_record_address_collision'
        || code === 'plugin_session_record_kind_conflict'
        || code === 'plugin_session_record_revision_conflict'
        || code === 'plugin_session_record_revision_exhausted'
        || code === 'plugin_session_record_storage_mode_mismatch') return 409;
    return 500;
}

export function toPublicSessionSystemRecord(record: SessionSystemRecordRow) {
    return {
        id: record.id,
        sessionId: record.sessionId,
        namespace: record.namespace,
        kind: record.kind,
        localId: record.localId,
        content: record.content,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
    };
}
