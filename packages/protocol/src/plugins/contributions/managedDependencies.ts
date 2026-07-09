import type { z } from 'zod';

import { InstallableDependencyDescriptorSchema } from '../../installables/descriptor.js';

export const PluginManagedDependencyContributionV2Schema = InstallableDependencyDescriptorSchema;
export type PluginManagedDependencyContributionV2 = z.infer<typeof PluginManagedDependencyContributionV2Schema>;
