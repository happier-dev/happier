import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import {
    buildTranscriptAnnotationPresentationV1,
    TRANSCRIPT_ANNOTATION_ATTACHMENT_IDENTITY_V1,
    TranscriptAnnotationV1Schema,
    type TranscriptAnnotationV1,
} from '@happier-dev/protocol/plugins/ui/transcriptAnnotation';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { randomUUID } from '@/platform/randomUUID';

import { applyMountedComposerTransaction } from './applyMountedComposerTransaction';

/** Attach reference data to the presented Session draft without submitting it. */
export async function addMountedTranscriptAnnotation(input: Readonly<{
    scope: ServerAccountScope;
    ref: ComposerRefV1;
    annotation: TranscriptAnnotationV1;
}>): Promise<boolean> {
    if (input.ref.kind !== 'session') return false;
    const annotation = TranscriptAnnotationV1Schema.safeParse(input.annotation);
    if (!annotation.success) return false;
    return await applyMountedComposerTransaction({
        scope: input.scope,
        ref: input.ref,
        attachmentContributor: TRANSCRIPT_ANNOTATION_ATTACHMENT_IDENTITY_V1,
        operations: () => [{
            kind: 'attachment.add',
            attachmentLocalId: TRANSCRIPT_ANNOTATION_ATTACHMENT_IDENTITY_V1.localId,
            value: {
                key: randomUUID(),
                value: annotation.data,
                presentation: buildTranscriptAnnotationPresentationV1(annotation.data),
            },
        }],
    });
}
