import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

function isRootOrUnsafeSelectedMutationPath(rawPath: string): boolean {
  if (!rawPath) return true;
  if (rawPath.includes('\0')) return true;
  if (rawPath.startsWith('-') || rawPath.startsWith(':')) return true;
  if (rawPath.startsWith('/') || rawPath.startsWith('~')) return true;
  if (/^[A-Za-z]:/.test(rawPath)) return true;

  const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.') return true;
  const parts = normalized.split('/');
  return parts.some((part) => !part || part === '..');
}

export const ScmSelectedMutationPathSchema = lazyZodSchema(() => z.string().check(z.superRefine((value, ctx) => {
  if (!isRootOrUnsafeSelectedMutationPath(value)) return;
  ctx.addIssue({
    code: "custom",
    message: 'Selected mutation path must identify a file or subdirectory inside the repository',
  });
})));

export type ScmSelectedMutationPath = z.infer<typeof ScmSelectedMutationPathSchema>;
