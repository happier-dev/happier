import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { ProviderBoundModelRefSchema } from '../providers/selection/v1.js';
import { SESSION_PERMISSION_MODES } from '../sessions/metadata/sessionPermissionModes.js';

export const CallerInputConstraintsV1Schema = lazyZodSchema(() => z.object({
  models: z.array(ProviderBoundModelRefSchema).min(1).nullable(),
  // Permission grants must reject unknown modes; the metadata reader's catch(default) is not admission.
  permissionModes: z.array(z.enum(SESSION_PERMISSION_MODES)).min(1).nullable(),
}).strict());
export type CallerInputConstraintsV1 = z.infer<typeof CallerInputConstraintsV1Schema>;
