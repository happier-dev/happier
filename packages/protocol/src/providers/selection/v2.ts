import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { ProviderAgentTargetKeySchema, ProviderConnectionIdSchema, ProviderModelIdSchema } from '../ids.js';
import { SessionModelSelectionV1Schema, type SessionModelSelectionV1 } from './v1.js';
import { TeamCredentialRouteV1Schema, type TeamCredentialRouteV1 } from '../../teams/credentials/resourceV1.js';

export const NativeSessionModelRefV2Schema = lazyZodSchema(() => z.object({
  source: z.literal('native'),
  agentTargetKey: ProviderAgentTargetKeySchema,
  modelId: ProviderModelIdSchema,
}).strict());

export const AccountProviderConnectionSessionModelRefV2Schema = lazyZodSchema(() => z.object({
  source: z.literal('account_provider_connection'),
  agentTargetKey: ProviderAgentTargetKeySchema,
  providerConnectionId: ProviderConnectionIdSchema,
  modelId: ProviderModelIdSchema,
}).strict());

export const TeamResourceSessionModelRefV2Schema = lazyZodSchema(() => z.object({
  source: z.literal('team_resource'),
  resourceId: z.string().min(1),
  teamId: z.string().min(1),
  expectedResourceRevision: z.number().int().nonnegative(),
  deliveryMode: TeamCredentialRouteV1Schema,
  agentTargetKey: ProviderAgentTargetKeySchema,
  modelId: ProviderModelIdSchema,
}).strict());

export const SessionModelRefV2Schema = lazyZodSchema(() => z.discriminatedUnion('source', [
  NativeSessionModelRefV2Schema,
  AccountProviderConnectionSessionModelRefV2Schema,
  TeamResourceSessionModelRefV2Schema,
]));
export type SessionModelRefV2 = z.infer<typeof SessionModelRefV2Schema>;

const SessionModelSelectionV2BaseShape = {
  v: z.literal(2),
  updatedAt: z.number().finite().nonnegative(),
} as const;

const TeamResourceSessionModelSelectionV2Schema = lazyZodSchema(() => z.object({
  ...SessionModelSelectionV2BaseShape,
  ref: TeamResourceSessionModelRefV2Schema,
}).strict());

export const SessionModelSelectionV2Schema = lazyZodSchema(() => z.union([
  z.object({
    ...SessionModelSelectionV2BaseShape,
    ref: NativeSessionModelRefV2Schema,
  }).strict(),
  z.object({
    ...SessionModelSelectionV2BaseShape,
    ref: AccountProviderConnectionSessionModelRefV2Schema,
  }).strict(),
  TeamResourceSessionModelSelectionV2Schema,
]));
export type SessionModelSelectionV2 = z.infer<typeof SessionModelSelectionV2Schema>;

/** Older readers may consume only the two sources they can represent. */
export function projectSessionModelSelectionV2ToV1(
  value: SessionModelSelectionV2,
): SessionModelSelectionV1 | null {
  const selection = SessionModelSelectionV2Schema.parse(value);
  if (selection.ref.source === 'team_resource') return null;
  return SessionModelSelectionV1Schema.parse({
    v: 1,
    ref: {
      agentTargetKey: selection.ref.agentTargetKey,
      providerConnectionId: selection.ref.source === 'native'
        ? null
        : selection.ref.providerConnectionId,
      modelId: selection.ref.modelId,
    },
    updatedAt: selection.updatedAt,
  });
}

/** Sidecar consumed by the canonical Session create/configuration transaction. */
export function sessionModelSelectionV2TeamBindingIntent(
  value: SessionModelSelectionV2,
): Readonly<{
  v: 1;
  slot: Readonly<{ kind: 'provider_model' }>;
  resourceId: string;
  expectedResourceRevision: number;
  deliveryMode: TeamCredentialRouteV1;
  teamId?: string;
}> | Readonly<{
  v: 1;
  slot: Readonly<{ kind: 'provider_model' }>;
  resourceId: null;
}> {
  const selection = SessionModelSelectionV2Schema.parse(value);
  if (selection.ref.source !== 'team_resource') {
    return { v: 1, slot: { kind: 'provider_model' }, resourceId: null };
  }
  const teamSelection = TeamResourceSessionModelSelectionV2Schema.parse(selection);
  return {
    v: 1,
    slot: { kind: 'provider_model' },
    resourceId: teamSelection.ref.resourceId,
    expectedResourceRevision: teamSelection.ref.expectedResourceRevision,
    deliveryMode: teamSelection.ref.deliveryMode,
    teamId: teamSelection.ref.teamId,
  };
}
