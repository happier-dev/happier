import type { SessionSystemRecordRow } from "./sessionSystemRecordService";

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
