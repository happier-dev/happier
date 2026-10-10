import { lazyZodSchema } from '../../lazyZodSchema.js';
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
export const AgentSessionProviderBindingUpstreamV1Schema = lazyZodSchema(() => z.object({
  protocol: ProviderWireProtocolSchema,
  normalizedUrl: ProviderEndpointUrlSyntaxSchema.nullable(),
  credential: z.enum(['none', 'apiKey']),
}).strict());

const AgentSessionProviderBindingCommonV1Schema = lazyZodSchema(() => z.object({
  model: ProviderModelDescriptorV1Schema,
  upstream: AgentSessionProviderBindingUpstreamV1Schema,
  materialization: AgentProviderBindingLaunchMaterializationV1Schema,
}));

const AgentSessionAccountProviderBindingV1Schema = AgentSessionProviderBindingCommonV1Schema.extend({
  connectionId: ProviderConnectionIdSchema,
}).strict() satisfies z.ZodType<AgentSessionProviderBindingV1>;

export const AgentSessionTeamProviderBindingV1Schema = lazyZodSchema(() => AgentSessionProviderBindingCommonV1Schema.extend({
  source: z.object({
    kind: z.literal('team_resource'),
    resourceId: z.string().trim().min(1).max(256),
    resourceRevision: z.number().int().nonnegative(),
  }).strict(),
}).strict());

export const AgentSessionProviderBindingV1Schema = lazyZodSchema(() => z.union([
  AgentSessionAccountProviderBindingV1Schema,
  AgentSessionTeamProviderBindingV1Schema,
]));

export type AgentSessionProviderBindingUpstream = Readonly<{
  protocol: ProviderWireProtocol;
  normalizedUrl: string | null;
  credential: 'none' | 'apiKey';
}>;

export type AgentSessionProviderBinding = Readonly<{
  model: AgentModelDescriptor;
  upstream: AgentSessionProviderBindingUpstream;
  materialization: AgentProviderBindingLaunchMaterialization;
}> & (
  | Readonly<{ connectionId: ProviderConnectionId; source?: never }>
  | Readonly<{
      connectionId?: never;
      source: Readonly<{
        kind: 'team_resource';
        resourceId: string;
        resourceRevision: number;
      }>;
    }>
);

export type AgentSessionProviderBindingV1 = AgentSessionProviderBinding;
