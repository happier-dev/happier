import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { QualifiedConnectedAccountRefSchema, type QualifiedConnectedAccountRef } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { QualifiedConnectedAccountPurposeV1Schema, type QualifiedConnectedAccountPurposeV1 } from '../../connect/connectedAccountPurposes.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

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
export const AgentSessionProviderBindingUpstreamV1Schema = lazyZodSchema(() => z.strictObject({
  protocol: ProviderWireProtocolSchema,
  normalizedUrl: z.nullable(ProviderEndpointUrlSyntaxSchema),
  credential: z.enum(['none', 'apiKey']),
}));

const AgentSessionProviderBindingCommonV1Schema = lazyZodSchema(() => z.object({
  model: ProviderModelDescriptorV1Schema,
  upstream: AgentSessionProviderBindingUpstreamV1Schema,
  materialization: AgentProviderBindingLaunchMaterializationV1Schema,
}));

const AgentSessionAccountProviderBindingV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentSessionProviderBindingCommonV1Schema, {
  connectionId: ProviderConnectionIdSchema,
}))) satisfies z.ZodMiniType<AgentSessionProviderBindingV1>;

export const AgentSessionTeamProviderBindingV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentSessionProviderBindingCommonV1Schema, {
  source: z.strictObject({
    kind: z.literal('team_resource'),
    resourceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    resourceRevision: z.number().check(z.int(), z.nonnegative()),
  }),
})));

const AgentSessionConnectedAccountProviderBindingV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentSessionProviderBindingCommonV1Schema, {
  source: z.strictObject({ kind: z.literal('connected_account'), purpose: QualifiedConnectedAccountPurposeV1Schema,
    account: asProtocolZod(QualifiedConnectedAccountRefSchema) }),
})));

export const AgentSessionProviderBindingV1Schema = lazyZodSchema(() => z.union([
  AgentSessionAccountProviderBindingV1Schema,
  AgentSessionTeamProviderBindingV1Schema,
  AgentSessionConnectedAccountProviderBindingV1Schema,
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
      }> | Readonly<{ kind: 'connected_account'; purpose: QualifiedConnectedAccountPurposeV1; account: QualifiedConnectedAccountRef }>;
    }>
);

export type AgentSessionProviderBindingV1 = AgentSessionProviderBinding;
