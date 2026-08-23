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
  ProviderWireProtocolSchema,
  type ProviderWireProtocol,
} from '../capabilities/v1.js';
import { ProviderEndpointUrlSyntaxSchema } from '../endpointUrlSchema.js';
import {
  ProviderConnectionIdSchema,
  type ProviderConnectionId,
} from '../ids.js';

/**
 * The authorized upstream a live Provider binding points the Agent at, and
 * whether that binding supplies its own runtime credential.
 *
 * An Agent runtime needs both facts to decide whether the Agent's inherited
 * on-disk identity would answer for a route the user selected as a model
 * source. `normalizedUrl` is null only for a managed-local deployment, whose
 * listener URL is resolved by the managed runtime rather than authorized at
 * bind time; such a deployment always mints its own runtime credential.
 */
export const AgentSessionProviderBindingUpstreamV1Schema = z.object({
  protocol: ProviderWireProtocolSchema,
  normalizedUrl: ProviderEndpointUrlSyntaxSchema.nullable(),
  credential: z.enum(['none', 'apiKey']),
}).strict();

export const AgentSessionProviderBindingV1Schema = z.object({
  connectionId: ProviderConnectionIdSchema,
  model: ProviderModelDescriptorV1Schema,
  upstream: AgentSessionProviderBindingUpstreamV1Schema,
  materialization: AgentProviderBindingLaunchMaterializationV1Schema,
}).strict() satisfies z.ZodType<AgentSessionProviderBindingV1>;

export type AgentSessionProviderBindingUpstream = Readonly<{
  protocol: ProviderWireProtocol;
  normalizedUrl: string | null;
  credential: 'none' | 'apiKey';
}>;

export type AgentSessionProviderBinding = Readonly<{
  connectionId: ProviderConnectionId;
  model: AgentModelDescriptor;
  upstream: AgentSessionProviderBindingUpstream;
  materialization: AgentProviderBindingLaunchMaterialization;
}>;

export type AgentSessionProviderBindingV1 = AgentSessionProviderBinding;
