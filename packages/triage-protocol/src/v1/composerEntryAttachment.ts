import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from './bounds.js';
import {
    INTERNAL_TASK_SOURCE_V1,
    TriageComposerEntryIdentityValueV1Schema,
    TriageEntryRefV1Schema,
    internalTaskLocalRefV1,
    isInternalTaskReferenceV1,
    type TriageEntryRefV1,
} from './identity.js';

export const TRIAGE_ENTRY_ATTACHMENT_IDENTITY_V1 = Object.freeze({
    pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    localId: 'entry',
});

/** Project the selected entry into shared content without its draft presentation or connection. */
export function readTriageEntryComposerAttachmentRefV1(record: Readonly<{
    attachment: Readonly<{ pluginId: string; localId: string }>;
    value: unknown;
}>, viewerAccountId: string): TriageEntryRefV1 | null {
    if (record.attachment.pluginId !== TRIAGE_ENTRY_ATTACHMENT_IDENTITY_V1.pluginId
        || record.attachment.localId !== TRIAGE_ENTRY_ATTACHMENT_IDENTITY_V1.localId) return null;

    const parsed = TriageComposerEntryIdentityValueV1Schema.safeParse(record.value);
    if (!parsed.success) return null;
    const { entryRef } = parsed.data;
    if (!isInternalTaskReferenceV1(entryRef) || entryRef.collisionScope !== 'personal') return entryRef;

    if (!viewerAccountId) return null;
    const qualified = TriageEntryRefV1Schema.safeParse({
        source: INTERNAL_TASK_SOURCE_V1,
        ...internalTaskLocalRefV1(entryRef.entryId, viewerAccountId),
    });
    return qualified.success ? qualified.data : null;
}
