import { z } from 'zod';

export const ChangeKindSchema = z.enum([
  'account',
  'artifact',
  'feed',
  'friends',
  'friend_request',
  'friend_accepted',
  'kv',
  'machine',
  'session',
  'share',
]);

export type ChangeKind = z.infer<typeof ChangeKindSchema>;

export const ChangeEntrySchema = z.object({
  cursor: z.number().int().min(0),
  kind: ChangeKindSchema,
  entityId: z.string(),
  changedAt: z.number().int().min(0),
  hint: z.unknown().nullable().optional(),
}).strict();

export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;

export const ChangesResponseSchema = z.object({
  changes: z.array(ChangeEntrySchema),
  nextCursor: z.number().int().min(0),
}).strict();

export type ChangesResponse = z.infer<typeof ChangesResponseSchema>;

export const CursorGoneErrorSchema = z.object({
  error: z.literal('cursor-gone'),
  currentCursor: z.number().int().min(0),
}).strict();

export type CursorGoneError = z.infer<typeof CursorGoneErrorSchema>;

