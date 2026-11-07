import {
    TRANSCRIPT_ANNOTATION_ATTACHMENT_IDENTITY_V1 as canonicalAttachmentIdentity,
    TranscriptAnnotationV1AttachmentSchema,
    type TranscriptAnnotationV1,
} from '@happier-dev/protocol/plugins/ui/transcriptAnnotation';
import type { PluginUiSchema } from '../ui/publicContract.js';
import type { PluginJsonSchema } from './protocolFacade.js';

export { buildTranscriptAnnotationPresentationV1 } from '@happier-dev/protocol/plugins/ui/transcriptAnnotation';
export type { TranscriptAnnotationV1 } from '@happier-dev/protocol/plugins/ui/transcriptAnnotation';

/** Canonical standalone annotation schema for composer attachment declarations. */
export const ProtocolTranscriptAnnotationV1Schema: PluginUiSchema<TranscriptAnnotationV1> & Readonly<{
    jsonSchema: PluginJsonSchema;
}> = TranscriptAnnotationV1AttachmentSchema;

export const TRANSCRIPT_ANNOTATION_ATTACHMENT_IDENTITY_V1: Readonly<{
    pluginId: 'happier.app-context'; localId: 'transcript-annotation';
}> = canonicalAttachmentIdentity;
