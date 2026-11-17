import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { NonBlankOpaqueIdentifierSchema } from '../../strings/opaqueIdentifier.js';
import { z } from '../../zodRuntimePolicy.js';

import { ProviderAgentTargetKeySchema, ProviderConnectionIdSchema, ProviderModelIdSchema } from '../ids.js';
import { ProviderBoundModelRefSchema, SessionActiveModelSelectionV1Schema, SessionModelSelectionV1Schema, serializeSessionModelSelectionV1, deserializeSessionModelSelectionV1, type SessionActiveModelSelectionV1, type SessionModelSelectionV1 } from './v1.js';
import { TeamCredentialProviderModelSelectionV1Schema, TeamCredentialRouteV1Schema, type TeamCredentialProviderModelSelectionV1 } from '../../teams/credentials/resourceV1.js';
import { SessionTeamCredentialNativeDeliveryV1Schema, type SessionTeamCredentialBindingIntentV1, type SessionTeamCredentialProviderModelSelectionV1 } from '../../teams/credentials/sessionBindingIntentV1.js';

/** The existing active-model carrier's second epoch retains the runtime-opened Team source. */
export const SessionActiveModelSelectionV2Schema = lazyZodSchema(() => z.strictObject({
  ...SessionActiveModelSelectionV1Schema.shape,
  v: z.literal(2),
  teamCredentialModel: TeamCredentialProviderModelSelectionV1Schema,
}).check(z.superRefine((fact, context) => {
  if (fact.selection.providerConnectionId !== null
    || fact.selection.agentTargetKey !== fact.teamCredentialModel.agentTargetKey
    || fact.selection.modelId !== fact.teamCredentialModel.modelId) {
    context.addIssue({ code: 'custom', path: ['teamCredentialModel'], message: 'Applied Team source must match the active model' });
  }
})));
export type SessionActiveModelSelectionV2 = z.infer<typeof SessionActiveModelSelectionV2Schema>;
export const SessionActiveModelSelectionSchema = lazyZodSchema(() => z.union([
  SessionActiveModelSelectionV2Schema, SessionActiveModelSelectionV1Schema,
]));
export type SessionActiveModelSelection = z.infer<typeof SessionActiveModelSelectionSchema>;

/** Only accepted native-open facts can qualify the model tuple; intent never supplies its source. */
export function createSessionActiveModelSelection(input: Readonly<{
  selection: SessionActiveModelSelectionV1['selection'];
  source: SessionActiveModelSelectionV1['source'];
  runner: SessionActiveModelSelectionV1['runner'];
  teamCredentialModel: TeamCredentialProviderModelSelectionV1 | null | undefined;
}>): SessionActiveModelSelection | null {
  const { teamCredentialModel, ...fact } = input;
  if (teamCredentialModel === undefined) return null;
  const parsed = SessionActiveModelSelectionSchema.safeParse(teamCredentialModel === null
    ? { ...fact, v: 1 } : { ...fact, v: 2, teamCredentialModel });
  return parsed.success ? parsed.data : null;
}

export const NativeSessionModelRefV2Schema = lazyZodSchema(() => z.strictObject({
  source: z.literal('native'),
  agentTargetKey: ProviderAgentTargetKeySchema,
  modelId: NonBlankOpaqueIdentifierSchema,
}));

export const AccountProviderConnectionSessionModelRefV2Schema = lazyZodSchema(() => z.strictObject({
  source: z.literal('account_provider_connection'),
  agentTargetKey: ProviderAgentTargetKeySchema,
  providerConnectionId: ProviderConnectionIdSchema,
  modelId: ProviderModelIdSchema,
}));

export const TeamResourceSessionModelRefV2Schema = lazyZodSchema(() => z.strictObject({
  source: z.literal('team_resource'),
  resourceId: z.string().check(z.minLength(1)),
  teamId: z.string().check(z.minLength(1)),
  expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
  deliveryMode: TeamCredentialRouteV1Schema,
  nativeDelivery: z.optional(SessionTeamCredentialNativeDeliveryV1Schema),
  agentTargetKey: ProviderAgentTargetKeySchema,
  modelId: ProviderModelIdSchema,
}).check(z.superRefine((selection, context) => {
  if (selection.nativeDelivery && selection.deliveryMode !== 'vendor-native') {
    context.addIssue({ code: 'custom', path: ['nativeDelivery'], message: 'Native references require native delivery' });
  }
})));

export const SessionModelRefV2Schema = lazyZodSchema(() => z.discriminatedUnion('source', [
  NativeSessionModelRefV2Schema,
  AccountProviderConnectionSessionModelRefV2Schema,
  TeamResourceSessionModelRefV2Schema,
]));
export type SessionModelRefV2 = z.infer<typeof SessionModelRefV2Schema>;

/** Ref-only consumers accept the same source variants as the Session launch carrier. */
export const SessionModelRefSchema = lazyZodSchema(() => z.union([
  SessionModelRefV2Schema, ProviderBoundModelRefSchema,
]));
export type SessionModelRef = z.infer<typeof SessionModelRefSchema>;

const SessionModelSelectionV2BaseShape = {
  v: z.literal(2),
  updatedAt: z.number().check(z.nonnegative()),
} as const;

const TeamResourceSessionModelSelectionV2Schema = lazyZodSchema(() => z.strictObject({
  ...SessionModelSelectionV2BaseShape,
  ref: TeamResourceSessionModelRefV2Schema,
}));

export const SessionModelSelectionV2Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    ...SessionModelSelectionV2BaseShape,
    ref: NativeSessionModelRefV2Schema,
  }),
  z.strictObject({
    ...SessionModelSelectionV2BaseShape,
    ref: AccountProviderConnectionSessionModelRefV2Schema,
  }),
  TeamResourceSessionModelSelectionV2Schema,
]));
export type SessionModelSelectionV2 = z.infer<typeof SessionModelSelectionV2Schema>;

/** Current Session launch carrier; retained V1 inputs keep their original source. */
export const SessionModelSelectionSchema = lazyZodSchema(() => z.union([
  SessionModelSelectionV2Schema, SessionModelSelectionV1Schema,
]));
export type SessionModelSelection = z.infer<typeof SessionModelSelectionSchema>;

const modelSelectionEncoder = new TextEncoder();
const modelSelectionDecoder = new TextDecoder('utf-8', { fatal: true });

/** Process transport preserves the authored source; the retained V1 encoding is unchanged. */
export function serializeSessionModelSelection(value: SessionModelSelection): string {
  if (value.v === 1) return serializeSessionModelSelectionV1(value);
  const selection = SessionModelSelectionV2Schema.parse(value);
  return `sms2:${encodeBase64(modelSelectionEncoder.encode(JSON.stringify(selection)), 'base64url').replace(/=+$/u, '')}`;
}

export function deserializeSessionModelSelection(value: string): SessionModelSelection {
  if (value.startsWith('sms1:')) return deserializeSessionModelSelectionV1(value);
  if (!value.startsWith('sms2:')) throw new Error('Invalid session model selection transport');
  try {
    const selection = SessionModelSelectionV2Schema.parse(JSON.parse(
      modelSelectionDecoder.decode(decodeBase64(value.slice(5), 'base64url')),
    ) as unknown);
    if (serializeSessionModelSelection(selection) !== value) throw new Error('Invalid session model selection transport');
    return selection;
  } catch {
    throw new Error('Invalid session model selection transport');
  }
}

/** Account Provider binding is a distinct source from native and Team-resource binding. */
export function readSessionModelSelectionProviderConnectionId(selection: SessionModelSelection): SessionModelSelectionV1['ref']['providerConnectionId'] {
  return readSessionModelRefProviderConnectionId(selection.ref);
}

export function readSessionModelRefProviderConnectionId(ref: SessionModelRef): SessionModelSelectionV1['ref']['providerConnectionId'] {
  return 'providerConnectionId' in ref ? ref.providerConnectionId : null;
}

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
  context?: Pick<SessionTeamCredentialProviderModelSelectionV1, 'application' | 'executionMachineId' | 'nativeSource'>,
): SessionTeamCredentialBindingIntentV1 {
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
    providerModelSelection: { agentTargetKey: teamSelection.ref.agentTargetKey, modelId: teamSelection.ref.modelId, ...context },
    ...(teamSelection.ref.nativeDelivery ? { nativeDelivery: teamSelection.ref.nativeDelivery } : {}),
  };
}
