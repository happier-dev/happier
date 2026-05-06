import type { z } from 'zod';

import { InstallableDependencyDescriptorSchema } from '../../installables/descriptor.js';

export const PluginInstallableContributionV2Schema = InstallableDependencyDescriptorSchema;
export type PluginInstallableContributionV2 = z.infer<typeof PluginInstallableContributionV2Schema>;
