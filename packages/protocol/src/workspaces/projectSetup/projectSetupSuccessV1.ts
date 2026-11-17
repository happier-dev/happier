import * as z from '../../zodRuntimePolicy.js';

import { lazyDefinition } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

export const ProjectSetupSuccessV1Schema = lazyDefinition(() => z.strictObject({
    v: z.literal(1),
    workspaceRefId: z.string().check(z.minLength(1)),
    cwd: z.string().check(z.minLength(1)),
    platform: z.strictObject({ os: z.string().check(z.minLength(1)), arch: z.string().check(z.minLength(1)) }),
    reviewedEffectDigest: z.string().check(z.minLength(1)),
    setupInputsDigest: z.string().check(z.minLength(1)),
    environmentBindingReferences: z.array(z.string().check(z.minLength(1))),
    confirmedCommandCount: z.optional(z.number().check(z.int(), z.gte(0))),
    completedAtMs: z.optional(z.number().check(z.int(), z.gte(0))),
}).check(z.refine(value => value.completedAtMs !== undefined || value.confirmedCommandCount !== undefined, {
    message: 'Setup facts require a confirmed prefix or completed outcome.',
})));
export type ProjectSetupSuccessV1 = z.infer<typeof ProjectSetupSuccessV1Schema>;
export const StoredProjectSetupSuccessV1Schema = createStoredReadSchema(ProjectSetupSuccessV1Schema);
