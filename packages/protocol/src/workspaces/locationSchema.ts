import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

function isAbsoluteWorkspacePath(value: string): boolean {
  if (!value) return false;
  if (value.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith('\\\\')) return true;
  return false;
}

export const AbsoluteWorkspacePathSchema = lazySchema(() => z
  .string()
  .min(1)
  .refine(isAbsoluteWorkspacePath, 'workspace path must be absolute'));

export const WorkspaceLocationScmSchema = lazySchema(() => z
  .object({
    provider: z.literal('git'),
    rootPath: AbsoluteWorkspacePathSchema,
  })
  .strict());
export type WorkspaceLocationScm = z.infer<typeof WorkspaceLocationScmSchema>;
