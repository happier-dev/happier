import { z } from 'zod';

export const SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND = 'sessionAttachmentUpload';

export const StructuredImageInputKindV1Schema = z.enum(['localImage', 'image']);
export type StructuredImageInputKindV1 = z.infer<typeof StructuredImageInputKindV1Schema>;

export const StructuredImageInputV1Schema = z.object({
  id: z.string().trim().min(1),
  kind: StructuredImageInputKindV1Schema,
  path: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1).optional(),
  mimeType: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).optional(),
}).passthrough().superRefine((value, ctx) => {
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
});

export type StructuredImageInputV1 = z.infer<typeof StructuredImageInputV1Schema>;
