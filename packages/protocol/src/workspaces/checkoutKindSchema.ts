import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const WorkspaceCheckoutKindSchema = lazySchema(() => z.enum([
  'primary',
  'git_worktree',
]));
export type WorkspaceCheckoutKind = z.infer<typeof WorkspaceCheckoutKindSchema>;
