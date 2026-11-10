import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND = 'sessionAttachmentUpload';

export const StructuredImageInputKindV1Schema = lazyZodSchema(() => z.enum(['localImage', 'image']));
export type StructuredImageInputKindV1 = z.infer<typeof StructuredImageInputKindV1Schema>;

export const StructuredImageInputV1Schema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  kind: StructuredImageInputKindV1Schema,
  path: z.optional(z.string().check(z.trim(), z.minLength(1))),
  url: z.optional(z.string().check(z.trim(), z.minLength(1))),
  mimeType: z.optional(z.string().check(z.trim(), z.minLength(1))),
  label: z.optional(z.string().check(z.trim(), z.minLength(1))),
}).check(z.superRefine((value, ctx) => {
  if (value.kind === 'localImage' && !value.path) {
    ctx.addIssue({
      code: 'custom',
      path: ['path'],
      message: 'localImage inputs require a path',
    });
  }
  if (value.kind === 'image' && !value.url) {
    ctx.addIssue({
      code: 'custom',
      path: ['url'],
      message: 'image inputs require a URL',
    });
  }
})));

export type StructuredImageInputV1 = z.infer<typeof StructuredImageInputV1Schema>;
