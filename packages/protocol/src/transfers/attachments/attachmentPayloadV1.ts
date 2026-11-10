import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { BinaryBlobReferenceV1Schema } from '../../storage/binaryBlobV1.js';
import { AttachmentNameV1Schema, AttachmentRelativePathV1Schema } from './attachmentPathV1.js';

/** Environment-owned file handles stay process-local; this shared shape owns folder intake. */
export type AttachmentFolderSourceEntryV1<TFile> = Readonly<{ relativePath: string; source: TFile }>;
export type AttachmentFolderSourceV1<TFile> = Readonly<{
  kind: 'folder'; name: string; mimeType: 'inode/directory';
  entries: readonly AttachmentFolderSourceEntryV1<TFile>[]; directories?: readonly string[];
}>;
export type AttachmentSourceV1<TFile> = TFile | AttachmentFolderSourceV1<TFile>;

export type AttachmentFileV1<TFile> = Readonly<{ kind: 'file'; id: string; name: string; file: TFile }>;
export type AttachmentFolderEntryV1<TFile> = Readonly<{ relativePath: string; file: TFile }>;
export type AttachmentFolderV1<TFile> = Readonly<{
  kind: 'folder'; id: string; name: string;
  entries: readonly AttachmentFolderEntryV1<TFile>[]; directories: readonly string[];
}>;
export type AttachmentPayloadV1<TFile> = AttachmentFileV1<TFile> | AttachmentFolderV1<TFile>;

export const StoredAttachmentPayloadV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), id: z.string().check(z.uuid()), name: AttachmentNameV1Schema, file: BinaryBlobReferenceV1Schema })
    .check(z.refine(attachment => attachment.id === attachment.file.blobId, 'File attachments retain the selected draft identity')),
  z.strictObject({ kind: z.literal('folder'), id: z.string().check(z.uuid()), name: AttachmentNameV1Schema,
    entries: z.array(z.strictObject({ relativePath: AttachmentRelativePathV1Schema, file: BinaryBlobReferenceV1Schema })),
    directories: z.array(AttachmentRelativePathV1Schema),
  }).check(z.superRefine((folder, context) => {
    const files = new Set<string>(), directories = new Set<string>();
    for (const entry of folder.entries) {
      if (files.has(entry.relativePath)) context.addIssue({ code: 'custom', message: 'Attachment file paths must be unique' });
      files.add(entry.relativePath);
    }
    for (const path of folder.directories) {
      if (directories.has(path) || files.has(path)) context.addIssue({ code: 'custom', message: 'Attachment directory paths must be unique and distinct from files' });
      directories.add(path);
    }
    for (const path of [...files, ...directories]) {
      const segments = path.split('/');
      segments.pop();
      while (segments.length > 0) {
        if (files.has(segments.join('/'))) context.addIssue({ code: 'custom', message: 'An attachment file cannot contain another entry' });
        segments.pop();
      }
    }
  })),
]));
export type StoredAttachmentPayloadV1 = z.infer<typeof StoredAttachmentPayloadV1Schema>;

export function readAttachmentPayloadFilesV1<TFile>(attachment: AttachmentPayloadV1<TFile>): readonly TFile[] {
  return attachment.kind === 'file' ? [attachment.file] : attachment.entries.map(entry => entry.file);
}
