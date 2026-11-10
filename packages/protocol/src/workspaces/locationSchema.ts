import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

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
  .string().check(z.minLength(1), z.maxLength(ABSOLUTE_WORKSPACE_PATH_MAX_LENGTH), z.refine((value) => !value.includes('\0'), 'workspace path must not contain NUL'), z.refine(isAbsoluteWorkspacePath, 'workspace path must be absolute')));

export const WorkspaceLocationScmSchema = lazyZodSchema(() => z.strictObject({
    provider: z.literal('git'),
    rootPath: AbsoluteWorkspacePathSchema,
  }));
export type WorkspaceLocationScm = z.infer<typeof WorkspaceLocationScmSchema>;
