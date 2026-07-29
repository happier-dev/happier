import { z } from 'zod';

function isRootOrUnsafeSelectedMutationPath(rawPath: string): boolean {
  const trimmed = rawPath.trim();
  if (!trimmed) return true;
  if (trimmed.includes('\0')) return true;
  if (trimmed.startsWith('-') || trimmed.startsWith(':')) return true;
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) return true;
  if (/^[A-Za-z]:/.test(trimmed)) return true;

  const normalized = trimmed.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.') return true;
  const parts = normalized.split('/');
  return parts.some((part) => !part || part === '..');
}

export const ScmSelectedMutationPathSchema = z.string().superRefine((value, ctx) => {
  if (!isRootOrUnsafeSelectedMutationPath(value)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Selected mutation path must identify a file or subdirectory inside the repository',
  });
});

export type ScmSelectedMutationPath = z.infer<typeof ScmSelectedMutationPathSchema>;
