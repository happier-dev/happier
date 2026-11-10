import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { ProviderBoundModelRefSchema } from '../providers/selection/v1.js';
import { SESSION_PERMISSION_MODES } from '../sessions/metadata/sessionPermissionModes.js';

export const CallerInputConstraintsV1Schema = lazyZodSchema(() => z.strictObject({
  models: z.nullable(z.array(ProviderBoundModelRefSchema).check(z.minLength(1))),
  // Permission grants must reject unknown modes; the metadata reader's catch(default) is not admission.
  permissionModes: z.nullable(z.array(z.enum(SESSION_PERMISSION_MODES)).check(z.minLength(1))),
}));
export type CallerInputConstraintsV1 = z.infer<typeof CallerInputConstraintsV1Schema>;
