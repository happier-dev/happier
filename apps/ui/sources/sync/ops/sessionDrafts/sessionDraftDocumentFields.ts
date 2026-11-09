import type { SessionDraftDocumentV2} from '@happier-dev/protocol/drafts/sessionDraftsV2';
import type { JsonValue as StrictJsonValue} from '@happier-dev/protocol/json/strictJsonValue';
import type { SyncedSessionAuthoringValueV2 } from '@happier-dev/protocol/sessions/authoring/index';

export type DraftFieldPathV1 =
    | Readonly<{ kind: 'composer'; field: 'text' | 'mentions' | 'attachments' }>
    | Readonly<{ kind: 'authoring'; fieldId: keyof SyncedSessionAuthoringValueV2 }>
    | Readonly<{ kind: 'routing'; field: 'recipient' | 'agentContinuation' | 'executionRunDelivery' }>
    /** Human Discussion authoring fields share the same private document. */
    | Readonly<{ kind: 'title' }>
    | Readonly<{ kind: 'passage' }>
    | Readonly<{ kind: 'submission' }>
    | Readonly<{ kind: 'recipients' }>
    | Readonly<{ kind: 'replyTarget' }>
    | Readonly<{ kind: 'participants' }>
    | Readonly<{ kind: 'projectOpen'; field: 'selection' | 'uncertainInputs' | 'result' | 'retiredAttempt' }>
    | Readonly<{ kind: 'extension'; pluginId: string; fieldId: string }>;

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Reads a retained field without claiming the surrounding document is editable. */
export function getSessionDraftDocumentFieldValue(document: unknown, path: unknown): unknown {
    return record(getSessionDraftDocumentField(document, path))?.value ?? null;
}

/** The authoring field catalog validates these retained values independently. */
export function getSessionDraftAuthoringFieldValues(document: unknown): Readonly<Record<string, unknown>> {
    const target = record(record(document)?.target);
    const authoring = target?.kind === 'newSession' ? record(target.authoring) : null;
    return Object.fromEntries(Object.entries(authoring ?? {}).map(([fieldId, field]) => [fieldId, record(field)?.value]));
}

export function getSessionDraftDocumentField(document: SessionDraftDocumentV2 | null, path: DraftFieldPathV1): { mutationId: string; value: StrictJsonValue } | null;
export function getSessionDraftDocumentField(document: unknown, path: unknown): unknown;
export function getSessionDraftDocumentField(document: unknown, path: unknown): unknown {
    const draft = record(document);
    const fieldPath = record(path);
    if (!draft || !fieldPath) return null;
    if (fieldPath.kind === 'composer' && typeof fieldPath.field === 'string') {
        return record(draft.composer)?.[fieldPath.field];
    }
    if (fieldPath.kind === 'title') return draft.title ?? null;
    if (fieldPath.kind === 'passage') return draft.passage ?? null;
    if (fieldPath.kind === 'submission') return draft.submission ?? null;
    if (fieldPath.kind === 'recipients') return draft.recipients ?? null;
    if (fieldPath.kind === 'replyTarget') return draft.replyTarget ?? null;
    if (fieldPath.kind === 'participants') return draft.participants ?? null;
    const target = record(draft.target);
    if (fieldPath.kind === 'projectOpen' && typeof fieldPath.field === 'string') {
        return target?.kind === 'projectOpen' ? draft[fieldPath.field] ?? null : null;
    }
    if (fieldPath.kind === 'routing' && typeof fieldPath.field === 'string') {
        return target?.kind === 'session' ? record(target.routing)?.[fieldPath.field] : null;
    }
    if (fieldPath.kind === 'authoring' && typeof fieldPath.fieldId === 'string') {
        return target?.kind === 'newSession' ? record(target.authoring)?.[fieldPath.fieldId] ?? null : null;
    }
    if (fieldPath.kind === 'extension' && typeof fieldPath.pluginId === 'string' && typeof fieldPath.fieldId === 'string') {
        return record(record(draft.extensions)?.[fieldPath.pluginId])?.[fieldPath.fieldId] ?? null;
    }
    return undefined;
}
