import { SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND } from '../../runtime/input/imageInputV1.js';
import { SessionAttachmentHandleV1Schema, type SessionAttachmentHandleV1 } from '../../transfers/sessions/sessionAttachmentHandleV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { readSessionAttachmentEnvelopeRecordsV1 } from '../../runtime/input/structuredInputV1.js';

/** Presentation of an upload; parsing it does not authorize reading its path. */
export const SessionAttachmentDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.optional(z.string().check(z.minLength(1))),
  name: z.string().check(z.minLength(1)),
  path: z.string().check(z.minLength(1)),
  mimeType: z.optional(z.string()),
  sizeBytes: z.number().check(z.int(), z.nonnegative()),
  sha256: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/i))),
  attachmentHandle: z.optional(SessionAttachmentHandleV1Schema),
}));
export type SessionAttachmentDescriptorV1 = Readonly<z.infer<typeof SessionAttachmentDescriptorV1Schema>>;

export const SessionAttachmentsMessageMetaV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('attachments.v1'),
  payload: z.strictObject({ attachments: z.array(SessionAttachmentDescriptorV1Schema) }),
}));
export type SessionAttachmentsMessageMetaV1 = Readonly<z.infer<typeof SessionAttachmentsMessageMetaV1Schema>>;

type StructuredInputImageInput = Readonly<{
  id?: string;
  type: 'localImage'; kind: 'localImage'; localPath: string; path: string;
  provenance?: Readonly<{ kind: string }>;
  name: string; mimeType?: string; sizeBytes: number; sha256?: string;
}>;

export type UploadedAttachment = Readonly<{
  id?: string;
  name: string; path: string; mimeType?: string; sizeBytes: number; sha256?: string;
  attachmentHandle?: SessionAttachmentHandleV1;
  structuredInput?: StructuredInputImageInput;
}>;

/** Shared projection for ordinary uploads and target-owned issued selections. */
export function buildUploadedAttachment(args: Omit<UploadedAttachment, 'structuredInput'>): UploadedAttachment {
  const structuredInput: StructuredInputImageInput | undefined = args.mimeType?.toLowerCase().startsWith('image/')
    ? { ...(args.id ? { id: args.id } : {}), type: 'localImage', kind: 'localImage', localPath: args.path, path: args.path,
      provenance: { kind: SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND },
      name: args.name, mimeType: args.mimeType, sizeBytes: args.sizeBytes,
      ...(args.sha256 ? { sha256: args.sha256 } : {}) }
    : undefined;
  return { ...args, ...(structuredInput ? { structuredInput } : {}) };
}

export function buildAttachmentMessageMeta(uploaded: readonly UploadedAttachment[]): Record<string, unknown> {
  const imageInputs = uploaded.flatMap(attachment => attachment.structuredInput
    ? [{ ...attachment.structuredInput, ...(attachment.id ? { id: attachment.id } : {}), provenance: { kind: SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND } }]
    : []);
  return {
    happier: { kind: 'attachments.v1', payload: { attachments: uploaded.map(attachment => ({
      ...(attachment.id ? { id: attachment.id } : {}),
      name: attachment.name, path: attachment.path,
      ...(attachment.mimeType !== undefined ? { mimeType: attachment.mimeType } : {}),
      sizeBytes: attachment.sizeBytes,
      ...(attachment.sha256 !== undefined ? { sha256: attachment.sha256 } : {}),
      ...(attachment.attachmentHandle ? { attachmentHandle: attachment.attachmentHandle } : {}),
    })) } },
    ...(imageInputs.length ? { happierStructuredInputV1: { v: 1, imageInputs } } : {}),
  };
}

/** Reads presentation descriptors at the incumbent envelope boundary, never path authority. */
export function readSessionAttachmentDescriptorsV1(meta: unknown): readonly SessionAttachmentDescriptorV1[] {
  return readSessionAttachmentEnvelopeRecordsV1(meta).flatMap(value => {
    const parsed = SessionAttachmentDescriptorV1Schema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Authored selection preview; only a target-issued upload can supply an accessible path. */
export function formatAttachmentSelectionSummary(selected: readonly Readonly<
  Pick<UploadedAttachment, 'name' | 'mimeType'> & { sizeBytes?: number }
>[]): string {
  if (selected.length === 0) return '';
  return ['Attachments:', ...selected.map(attachment => {
    const details = [
      ...(attachment.mimeType ? [attachment.mimeType] : []),
      ...(attachment.sizeBytes !== undefined ? [`${attachment.sizeBytes} bytes`] : []),
    ];
    return `- ${attachment.name}${details.length ? ` (${details.join(', ')})` : ''}`;
  })].join('\n');
}
