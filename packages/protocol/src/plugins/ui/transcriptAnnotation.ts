import { z } from 'zod/mini';

import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import { SessionMessageRefV1Schema } from '../../sessions/messages/sessionMessageRefV1.js';
import { MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1, MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1 } from '../../runtime/input/composerAttachmentV1.js';
import { normalizePluginJsonSchema } from '../actions/protocolComposableSchema.js';

/** First-party attachment for a note on an exact committed transcript passage. */
export const TRANSCRIPT_ANNOTATION_ATTACHMENT_IDENTITY_V1 = Object.freeze({
  pluginId: 'happier.app-context', localId: 'transcript-annotation',
} as const);

// Validate nonblank prose without transforming the selected passage's whitespace.
const AnnotationTextV1Schema = lazyZodSchema(() => z.string().check(z.regex(/\S/)));

export const TranscriptAnnotationV1Schema = lazyZodSchema(() => z.strictObject({
  quote: AnnotationTextV1Schema,
  note: AnnotationTextV1Schema,
  source: SessionMessageRefV1Schema,
}));
export type TranscriptAnnotationV1 = z.infer<typeof TranscriptAnnotationV1Schema>;

/** Immutable admitted display facts; full quote and note remain in the attachment value. */
export function buildTranscriptAnnotationPresentationV1(annotation: TranscriptAnnotationV1): Readonly<{
  label: string; description: string; source: TranscriptAnnotationV1['source'];
}> {
  const excerpt = (text: string, limit: number) => Array.from(text.trim().replace(/\s+/g, ' ')).slice(0, limit).join('').trimEnd();
  return {
    label: excerpt(annotation.quote, MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1),
    description: excerpt(annotation.note, MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1),
    source: annotation.source,
  };
}

/** Standalone declaration derived from the same parser used at dispatch. */
export const TranscriptAnnotationV1AttachmentSchema = lazyDefinition(() => Object.freeze({
  jsonSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(TranscriptAnnotationV1Schema, { target: 'draft-7' })),
  parse: (value: unknown) => TranscriptAnnotationV1Schema.parse(value),
  safeParse: (value: unknown) => TranscriptAnnotationV1Schema.safeParse(value),
}));
