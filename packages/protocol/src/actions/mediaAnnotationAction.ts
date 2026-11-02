import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { EntityDragScopeV1Schema } from '../plugins/ui/entityDragDrop.js';
import { ComposerRefV1Schema } from '../plugins/ui/composer.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ImageMarksDocumentV1Schema, ImageMarksImageV1Schema, ImageMarksOperationV1Schema } from '../sessions/media/imageMarksV1.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

const identity = () => z.string().check(z.minLength(1));
export const MediaAnnotationTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('composerAttachment'), ref: asProtocolZod(ComposerRefV1Schema), attachmentId: identity() }),
  z.strictObject({ kind: z.literal('sessionImage'), sessionId: identity(), mediaId: identity() }),
  z.strictObject({ kind: z.literal('browserView'), browserSessionId: identity(), viewId: identity() }),
  z.strictObject({ kind: z.literal('capture'), captureRef: identity() }),
  z.strictObject({ kind: z.literal('recordingFrame'), captureRef: identity(), sourceTimeMs: z.number().check(z.int(), z.minimum(0)) }),
]));
const address = { scope: EntityDragScopeV1Schema, target: MediaAnnotationTargetV1Schema };
export const MediaAnnotationReadInputV1Schema = lazyZodSchema(() => z.strictObject(address));
export const MediaAnnotationApplyInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...address,
  operations: z.optional(z.array(ImageMarksOperationV1Schema)),
  cause: z.optional(z.enum(['edit', 'undo', 'redo'])),
  reset: z.optional(z.literal(true)),
  into: z.optional(z.strictObject({ sessionId: identity() })),
}).check(z.refine(input => (input.operations !== undefined) !== (input.reset === true)
  && (input.target.kind !== 'sessionImage' || input.into !== undefined)
  && (input.target.kind !== 'recordingFrame' || input.into === undefined)
  && (input.target.kind !== 'capture' || input.into === undefined)
  && (input.cause === undefined || input.target.kind === 'recordingFrame'))));
const unavailable = z.strictObject({ status: z.literal('unavailable'), reason: z.enum([
  'annotation.targetUnavailable', 'flatten.canvasUnavailable', 'flatten.decodeFailed',
]) });
export const MediaAnnotationReadResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ document: z.optional(ImageMarksDocumentV1Schema), image: ImageMarksImageV1Schema, hasBlur: z.boolean() }), unavailable,
]));
export const MediaAnnotationApplyResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.enum(['replaced', 'appended', 'reverted']), imageNumber: z.optional(z.number().check(z.int(), z.positive())) }), unavailable,
]));
export type MediaAnnotationReadInputV1 = z.infer<typeof MediaAnnotationReadInputV1Schema>;
export type MediaAnnotationApplyInputV1 = z.infer<typeof MediaAnnotationApplyInputV1Schema>;
export type MediaAnnotationReadResultV1 = z.infer<typeof MediaAnnotationReadResultV1Schema>;
export type MediaAnnotationApplyResultV1 = z.infer<typeof MediaAnnotationApplyResultV1Schema>;
export type MediaAnnotationActionRequestV1 = Readonly<
  | { actionId: 'media.annotation.read'; input: MediaAnnotationReadInputV1 }
  | { actionId: 'media.annotation.apply'; input: MediaAnnotationApplyInputV1 }
>;
const client = { executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  approval: { result: 'required' }, safety: 'safe', sideEffectClass: 'external',
} as const;
const fields = [
  { path: 'scope', title: 'Account scope', widget: 'json', required: true },
  { path: 'target', title: 'Picture occurrence', widget: 'json', required: true },
] as const;
export const MEDIA_ANNOTATION_ACTION_SPECS = [{
  ...client, id: 'media.annotation.read', title: 'Read picture marks',
  description: 'Read the editable marks and original image dimensions of a picture occurrence without opening an annotator.',
  cli: { commands: [{ path: ['media', 'annotation', 'read'], visibility: 'canonical' }] },
  bindings: { mcpToolName: 'media_annotation_read' },
  inputSchema: MediaAnnotationReadInputV1Schema, outputSchema: MediaAnnotationReadResultV1Schema,
  inputHints: { title: 'Read picture marks', fields: [...fields] },
}, {
  ...client, id: 'media.annotation.apply', title: 'Apply picture marks',
  description: 'Apply image-space mark operations through the same flatten and picture replacement used by the annotator. Blur is burned into PNG pixels. Reset restores the original. Session images require an into Session and create a copy; source messages are never changed.',
  cli: { commands: [{ path: ['media', 'annotation', 'apply'], visibility: 'canonical' }] },
  bindings: { mcpToolName: 'media_annotation_apply' },
  inputSchema: MediaAnnotationApplyInputV1Schema, outputSchema: MediaAnnotationApplyResultV1Schema,
  inputHints: { title: 'Apply picture marks', fields: [...fields,
    { path: 'operations', title: 'Mark operations', widget: 'json', required: false },
    { path: 'reset', title: 'Restore original', widget: 'boolean', required: false },
    { path: 'into', title: 'Copy destination', widget: 'json', required: false },
  ] },
}] as const satisfies readonly PreNormalizedActionSpec[];
