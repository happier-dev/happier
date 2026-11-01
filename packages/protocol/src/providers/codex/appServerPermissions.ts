import { z } from 'zod';
import { lazySchema } from '../../lazySchema.js';

export const CodexAppServerPermissionsProfileSchema = lazySchema(() => z.record(z.string(), z.unknown()));
export type CodexAppServerPermissionsProfile = z.infer<typeof CodexAppServerPermissionsProfileSchema>;

export const CodexAppServerTurnPermissionFieldsSchema = lazySchema(() => z
  .object({
    permissions: CodexAppServerPermissionsProfileSchema.optional(),
    sandboxPolicy: z.unknown().optional(),
    approvalPolicy: z.string().optional(),
    approvalsReviewer: z.string().optional(),
    sandbox: z.unknown().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.permissions !== undefined && value.sandboxPolicy !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'permissions and sandboxPolicy cannot be combined',
        path: ['sandboxPolicy'],
      });
    }
  }));
export type CodexAppServerTurnPermissionFields = z.infer<typeof CodexAppServerTurnPermissionFieldsSchema>;
