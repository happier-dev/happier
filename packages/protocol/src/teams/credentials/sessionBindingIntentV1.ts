import { buildBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import type { PersistedBackendTargetRefV2 } from '../../backends/targets/backendTargetRefV2.js';
import type { SessionModelSelection } from '../../providers/selection/v2.js';
import type { TeamCredentialProviderModelSelectionV1 } from './providerModelCatalogV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposeIdentity.js';
import { TeamCredentialRouteV1Schema, SessionTeamCredentialNativeDeliveryV1Schema } from './deliveryV1.js';
export { SessionTeamCredentialNativeDeliveryV1Schema, type SessionTeamCredentialNativeDeliveryV1 } from './deliveryV1.js';
import { ProviderAgentTargetKeySchema, ProviderModelIdSchema, ProviderMachineIdSchema } from '../../providers/ids.js';
import { ProviderBrokerApplicationBindingV1Schema } from '../../providers/brokerRouteGrantV1.js';

export const SessionTeamCredentialNativeSourceV1Schema = lazyZodSchema(() => z.strictObject({
  sourceRevision: z.string().check(z.minLength(1), z.maxLength(512)),
  providerTicket: SessionTeamCredentialNativeDeliveryV1Schema.shape.providerTicket,
}));

export const SessionTeamCredentialProviderModelSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  agentTargetKey: ProviderAgentTargetKeySchema,
  modelId: ProviderModelIdSchema,
  application: z.optional(ProviderBrokerApplicationBindingV1Schema),
  executionMachineId: z.optional(ProviderMachineIdSchema),
  nativeSource: z.optional(SessionTeamCredentialNativeSourceV1Schema),
}).check(z.superRefine((selection, context) => {
  if (selection.application && selection.application.agentTargetKey !== selection.agentTargetKey) {
    context.addIssue({ code: 'custom', path: ['application'], message: 'Application must match the selected Agent target' });
  }
  if ((selection.application === undefined) !== (selection.executionMachineId === undefined)) {
    context.addIssue({ code: 'custom', message: 'Application and execution Machine must be accepted together' });
  }
})));
export type SessionTeamCredentialProviderModelSelectionV1 = z.infer<typeof SessionTeamCredentialProviderModelSelectionV1Schema>;

export const SessionTeamCredentialProviderModelSlotV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('provider_model'),
}));

export const SessionTeamCredentialConnectedServicePurposeSlotV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('connected_service_purpose'),
  purpose: QualifiedConnectedAccountPurposeV1Schema,
}));

export const SessionTeamCredentialSlotV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  SessionTeamCredentialProviderModelSlotV1Schema,
  SessionTeamCredentialConnectedServicePurposeSlotV1Schema,
]));

export type SessionTeamCredentialSlotV1 = z.infer<typeof SessionTeamCredentialSlotV1Schema>;

/**
 * Browser-safe fresh-Session credential selection. The existing-Session
 * mutation contract lives in `sessionBindingV1.ts` because it additionally
 * carries the owner-metadata patch and its runtime crypto implementation.
 */
export const SessionTeamCredentialBindingIntentV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    v: z.literal(1), slot: SessionTeamCredentialSlotV1Schema,
    resourceId: z.string().check(z.minLength(1)), expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
    deliveryMode: TeamCredentialRouteV1Schema,
    /** Exact Team route for Provider-model bindings; retained inputs may omit it. */
    teamId: z.optional(z.string().check(z.minLength(1))),
    providerModelSelection: z.optional(SessionTeamCredentialProviderModelSelectionV1Schema),
    nativeDelivery: z.optional(SessionTeamCredentialNativeDeliveryV1Schema),
  }).check(z.superRefine((intent, context) => {
    if (intent.providerModelSelection && intent.slot.kind !== 'provider_model') {
      context.addIssue({ code: 'custom', path: ['providerModelSelection'], message: 'Provider selection requires the Provider-model slot' });
    }
    if (intent.nativeDelivery && (intent.slot.kind !== 'provider_model' || intent.deliveryMode !== 'vendor-native')) {
      context.addIssue({ code: 'custom', path: ['nativeDelivery'], message: 'Native references require native Provider delivery' });
    }
  })),
  z.strictObject({ v: z.literal(1), slot: SessionTeamCredentialSlotV1Schema, resourceId: z.null() }),
]));
export type SessionTeamCredentialBindingIntentV1 = z.infer<typeof SessionTeamCredentialBindingIntentV1Schema>;

export function sessionTeamCredentialSlotKeyV1(slot: SessionTeamCredentialSlotV1): string {
  const parsed = SessionTeamCredentialSlotV1Schema.parse(slot);
  return parsed.kind === 'provider_model'
    ? JSON.stringify(['provider_model'])
    : JSON.stringify(['connected_service_purpose', parsed.purpose.consumer.pluginId, parsed.purpose.consumer.localId, parsed.purpose.purpose]);
}

export const SessionTeamCredentialBindingIntentsV1Schema = lazyZodSchema(() => z.array(SessionTeamCredentialBindingIntentV1Schema).check(z.superRefine((intents, context) => {
    const seen = new Set<string>();
    for (const [index, intent] of intents.entries()) {
      const key = sessionTeamCredentialSlotKeyV1(intent.slot);
      if (seen.has(key)) context.addIssue({ code: 'custom', path: [index, 'slot'], message: 'Duplicate Session credential slot.' });
      seen.add(key);
    }
  })));

export type SessionTeamCredentialBindingIntentListV1 = z.infer<typeof SessionTeamCredentialBindingIntentsV1Schema>;

/**
 * A Session's creation-time Team slot bindings: an explicit binding the
 * caller chose for a slot wins; admitted durable defaults fill the others.
 */
export function mergeSessionTeamCredentialBindingIntents(params: Readonly<{
  explicit: SessionTeamCredentialBindingIntentListV1 | undefined;
  admitted: SessionTeamCredentialBindingIntentListV1 | null | undefined;
}>): SessionTeamCredentialBindingIntentListV1 | undefined {
  if (!params.admitted || params.admitted.length === 0) return params.explicit;
  const explicitSlotKeys = new Set(
    (params.explicit ?? []).map((intent) => sessionTeamCredentialSlotKeyV1(intent.slot)),
  );
  return SessionTeamCredentialBindingIntentsV1Schema.parse([
    ...(params.explicit ?? []).map(intent => {
      if (intent.resourceId === null || intent.teamId !== undefined) return intent;
      const admitted = params.admitted?.find(candidate => candidate.resourceId === intent.resourceId
        && candidate.resourceId !== null && candidate.deliveryMode === intent.deliveryMode
        && sessionTeamCredentialSlotKeyV1(candidate.slot) === sessionTeamCredentialSlotKeyV1(intent.slot));
      return admitted?.resourceId && admitted.teamId ? { ...intent, teamId: admitted.teamId } : intent;
    }),
    ...params.admitted.filter((intent) => !explicitSlotKeys.has(sessionTeamCredentialSlotKeyV1(intent.slot))),
  ]);
}

export function encodeSessionTeamCredentialSlotKeyV1(slot: SessionTeamCredentialSlotV1): Uint8Array {
  return new TextEncoder().encode(sessionTeamCredentialSlotKeyV1(slot));
}

type AuthoredModel = Readonly<{
  modelSelection?: SessionModelSelection | null;
  teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
}>;

export type AssignedProviderModelCredentialBinding = Extract<
  SessionTeamCredentialBindingIntentV1,
  Readonly<{ resourceId: string }>
> & Readonly<{ slot: Readonly<{ kind: 'provider_model' }> }>;

/** Read the assigned Provider-model intent without reinterpreting a clear. */
export function findAssignedProviderModelCredentialBinding(
  bindings: SessionTeamCredentialBindingIntentListV1 | null | undefined,
): AssignedProviderModelCredentialBinding | null {
  return bindings?.find((binding): binding is AssignedProviderModelCredentialBinding =>
    binding.slot.kind === 'provider_model' && binding.resourceId !== null) ?? null;
}

/** Restore the authored source; the catalog separately owns whether it can execute. */
export function readTeamCredentialProviderModelSelection(
  input: AuthoredModel | null | undefined,
): TeamCredentialProviderModelSelectionV1 | null {
  if (input?.modelSelection?.v === 2) {
    if (input.modelSelection.ref.source !== 'team_resource') return null;
    const { source: _source, ...ref } = input.modelSelection.ref;
    return { kind: 'team_credential_provider_model', ...ref };
  }
  const binding = findAssignedProviderModelCredentialBinding(input?.teamCredentialBindings);
  const legacyRef = input?.modelSelection?.ref;
  const ref = legacyRef ?? binding?.providerModelSelection;
  if (!binding?.teamId || !ref || (legacyRef && legacyRef.providerConnectionId !== null)) return null;
  return {
    kind: 'team_credential_provider_model', teamId: binding.teamId, resourceId: binding.resourceId,
    expectedResourceRevision: binding.expectedResourceRevision, deliveryMode: binding.deliveryMode,
    agentTargetKey: ref.agentTargetKey, modelId: ref.modelId,
    ...(binding.nativeDelivery ? { nativeDelivery: binding.nativeDelivery } : {}),
  };
}

/** Authored model intent in either its source-qualified or split representation. */
export function readAuthoredSessionModelSelection(
  input: AuthoredModel & Readonly<{ agentTarget?: PersistedBackendTargetRefV2 | null }>,
): SessionModelSelection | null | undefined {
  const selection = input.modelSelection;
  if (selection?.v === 2 || !input.agentTarget) return selection;
  const teamModel = readTeamCredentialProviderModelSelection(input);
  if (!teamModel || teamModel.agentTargetKey !== buildBackendTargetKeyV2(input.agentTarget)) return selection;
  const { kind: _kind, ...teamRef } = teamModel;
  return { v: 2, updatedAt: selection?.updatedAt ?? 0, ref: { source: 'team_resource', ...teamRef } };
}

/** Replace this slot without dropping Connected Service credential intents. */
export function replaceProviderModelCredentialBinding(
  bindings: SessionTeamCredentialBindingIntentListV1 | undefined,
  binding: (SessionTeamCredentialBindingIntentV1 & Readonly<{ slot: Readonly<{ kind: 'provider_model' }> }>) | null,
): SessionTeamCredentialBindingIntentListV1 {
  const retained = (bindings ?? []).filter(candidate => candidate.slot.kind !== 'provider_model');
  return binding ? [...retained, binding] : retained;
}
