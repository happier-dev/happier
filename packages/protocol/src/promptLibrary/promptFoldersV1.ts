import { z } from 'zod';

export const PromptFolderEntryV1Schema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parentId: z.string().min(1).nullable().optional(),
}).strict();
export type PromptFolderEntryV1 = z.infer<typeof PromptFolderEntryV1Schema>;

export const PromptFoldersV1Schema = z.object({
  v: z.literal(1),
  folders: z.array(PromptFolderEntryV1Schema).default([]),
}).strict();
export type PromptFoldersV1 = z.infer<typeof PromptFoldersV1Schema>;
