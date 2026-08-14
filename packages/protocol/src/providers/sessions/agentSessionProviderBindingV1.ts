import { z } from 'zod';

import {
  ProviderModelDescriptorV1Schema,
  type AgentModelDescriptor,
} from '../../models/descriptor.js';
import {
  AgentProviderBindingLaunchMaterializationV1Schema,
  type AgentProviderBindingLaunchMaterialization,
} from '../materialization/v1.js';
import {
  ProviderConnectionIdSchema,
  type ProviderConnectionId,
} from '../ids.js';

export const AgentSessionProviderBindingV1Schema = z.object({
  connectionId: ProviderConnectionIdSchema,
  model: ProviderModelDescriptorV1Schema,
  materialization: AgentProviderBindingLaunchMaterializationV1Schema,
}).strict() satisfies z.ZodType<AgentSessionProviderBindingV1>;

export type AgentSessionProviderBinding = Readonly<{
  connectionId: ProviderConnectionId;
  model: AgentModelDescriptor;
  materialization: AgentProviderBindingLaunchMaterialization;
}>;

export type AgentSessionProviderBindingV1 = AgentSessionProviderBinding;
