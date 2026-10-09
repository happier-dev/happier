import type { SessionDraftDocumentV2, StrictJsonValue, SyncedSessionAuthoringValueV2 } from '@happier-dev/protocol';

export type DraftFieldPathV1 =
    | Readonly<{ kind: 'composer'; field: 'text' | 'mentions' | 'attachments' }>
    | Readonly<{ kind: 'authoring'; fieldId: keyof SyncedSessionAuthoringValueV2 }>
    | Readonly<{ kind: 'routing'; field: 'recipient' | 'agentContinuation' | 'executionRunDelivery' }>
    /** New-discussion title; the human document owns no other top-level field. */
    | Readonly<{ kind: 'title' }>
    | Readonly<{ kind: 'projectOpen'; field: 'selection' | 'uncertainInputs' | 'result' | 'retiredAttempt' }>
    | Readonly<{ kind: 'extension'; pluginId: string; fieldId: string }>;

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
