import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

export const FILE_REVIEW_NOTE_KIND = 'file_review_note.v1' as const;

/** Content stays in the Session's ordinary encrypted/plain transcript envelope. */
export const FileReviewNoteOperationV1Schema = lazyZodSchema(() => z.strictObject({
  action: z.enum(['discard', 'restore', 'undo']),
  paths: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
  changeCount: z.optional(z.number().check(z.int(), z.positive())),
  turnId: z.optional(z.string().check(z.minLength(1))),
  undoes: z.optional(z.enum(['discard', 'restore'])),
}));
export type FileReviewNoteOperationV1 = z.infer<typeof FileReviewNoteOperationV1Schema>;

export const FileReviewNoteV1Schema = lazyZodSchema(() => z.union([
  FileReviewNoteOperationV1Schema,
  z.strictObject({
    action: z.literal('mixed'),
    operations: z.array(FileReviewNoteOperationV1Schema).check(z.minLength(2)),
  }),
]));
export type FileReviewNoteV1 = z.infer<typeof FileReviewNoteV1Schema>;

/** A content-free, non-ignorable admission operand, stamped into the receipt. */
export const NextTurnFileReviewNoteV1Schema = lazyZodSchema(() => z.literal(FILE_REVIEW_NOTE_KIND));

export function readFileReviewNoteV1(meta: unknown): FileReviewNoteV1 | null {
  if (!meta || typeof meta !== 'object' || !('happier' in meta)) return null;
  const envelope = meta.happier;
  if (!envelope || typeof envelope !== 'object' || !('kind' in envelope)
    || envelope.kind !== FILE_REVIEW_NOTE_KIND || !('payload' in envelope)) return null;
  const parsed = FileReviewNoteV1Schema.safeParse(envelope.payload);
  return parsed.success ? parsed.data : null;
}

/** Transcript copy addresses the person; provider context explicitly attributes their review actions. */
export function formatFileReviewNoteV1(note: FileReviewNoteV1, audience: 'person' | 'agent' = 'person'): string {
  if (note.action === 'mixed') return note.operations.map(operation => formatFileReviewNoteV1(operation, audience)).join(' ');
  const agent = audience === 'agent';
  const subject = agent ? 'The person reviewing your work' : 'You';
  const paths = note.paths.map(path => JSON.stringify(path)).join(', ');
  const turn = note.turnId ? ` (turn ${JSON.stringify(note.turnId)})` : '';
  if (note.action === 'undo') {
    return `${subject} undid ${note.undoes ? `the ${note.undoes}` : 'the file review action'} in ${paths}${turn}.`
      + (agent ? ' Respect the resulting file state unless asked to change it.' : '');
  }
  if (note.action === 'restore') return `${subject} restored ${paths}${note.turnId
    ? ` to before turn ${JSON.stringify(note.turnId)}` : ' to the previous state'}.`
    + (agent ? ' Do not undo this restoration unless asked.' : '');
  const count = note.changeCount;
  const changes = count === undefined ? `${agent ? 'your ' : ''}changes`
    : `${count}${agent ? ' of your' : ''} ${count === 1 && !agent ? 'change' : 'changes'}`;
  return `${subject} discarded ${changes} in ${paths}${turn}.` + (agent ? ' Do not reapply them unless asked.' : '');
}
