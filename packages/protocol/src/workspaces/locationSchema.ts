import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const ABSOLUTE_WORKSPACE_PATH_MAX_LENGTH = 10_000;

function isAbsoluteWorkspacePath(value: string): boolean {
  if (!value) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith('\\\\') || value.startsWith('//')) {
    return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/u.test(value);
  }
  return value.startsWith('/');
}

export const AbsoluteWorkspacePathSchema = lazyZodSchema(() => z
  .string()
  .min(1)
  .max(ABSOLUTE_WORKSPACE_PATH_MAX_LENGTH)
  .refine((value) => !value.includes('\0'), 'workspace path must not contain NUL')
  .refine(isAbsoluteWorkspacePath, 'workspace path must be absolute'));

export const WorkspaceLocationScmSchema = lazyZodSchema(() => z
  .object({
    provider: z.literal('git'),
    rootPath: AbsoluteWorkspacePathSchema,
  })
  .strict());
export type WorkspaceLocationScm = z.infer<typeof WorkspaceLocationScmSchema>;
