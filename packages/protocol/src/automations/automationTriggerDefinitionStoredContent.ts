import { z } from 'zod';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

import {
  isAccountScopedBlobCiphertextForKind,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../crypto/accountScopedCipher.js';
import {
  PluginJsonValueV2Schema,
  type PluginJsonValueV2,
} from '../plugins/contributions/publicTypes.js';
import {
  AutomationQualifiedPluginContributionRefV1Schema,
  AutomationSourceSelectorIdV1Schema,
  type AutomationSourceSelectorIdV1,
  type AutomationQualifiedPluginContributionRefV1,
} from './automationEventDeclarationV1.js';
import {
  AutomationStoredContentEnvelopeV1Schema,
  type AutomationStoredContentEnvelopeV1,
  type AutomationEventTriggerDefinitionStoredPayloadV1,
} from './automationEventV1.js';
import type {
  AutomationPluginEventDefinitionTrigger,
  AutomationPluginEventEncryptedDefinitionTrigger,
  AutomationEncryptedTriggerDefinitionEnvelopeV1,
} from './automationTriggerDefinition.js';
import {
  AutomationTriggerIdSchema,
  AutomationTriggerRevisionSchema,
} from './automationTriggerIdentity.js';
export const AUTOMATION_TRIGGER_DEFINITION_ACCOUNT_SCOPED_BLOB_KIND_V1 =
  'automation_trigger_definition' as const;

/**
 * Durable private definition binding. Event routing identity remains public on its
 * AutomationTrigger row; PR selectors need only the common identity tuple. This
 * prevents private content replay onto another trigger kind, definition or revision.
 */
const AutomationTriggerDefinitionBindingBaseV1Schema = z.object({
  v: z.literal(1),
  automationId: z.string().min(1).max(256),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
}).strict();
export const AutomationTriggerDefinitionBindingV1Schema = z.discriminatedUnion('triggerKind', [
  AutomationTriggerDefinitionBindingBaseV1Schema.extend({
    triggerKind: z.literal('pluginEvent'),
    eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
    sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  }).strict(),
  AutomationTriggerDefinitionBindingBaseV1Schema.extend({ triggerKind: z.literal('prComment') }).strict(),
  AutomationTriggerDefinitionBindingBaseV1Schema.extend({ triggerKind: z.literal('ciFailed') }).strict(),
]);
export type AutomationTriggerDefinitionBindingV1 = z.infer<
  typeof AutomationTriggerDefinitionBindingV1Schema
>;

/** Canonical mapping from caller-owned Event facts to a revision-bound private definition. */
export function sealAutomationPluginEventTriggerInputV1(params: Readonly<{
  binding: Extract<AutomationTriggerDefinitionBindingV1, { triggerKind: 'pluginEvent' }>;
  trigger: AutomationPluginEventDefinitionTrigger & Readonly<{ enabled: boolean }>;
  seal: (params: Readonly<{
    binding: Extract<AutomationTriggerDefinitionBindingV1, { triggerKind: 'pluginEvent' }>;
    definition: AutomationEventTriggerDefinitionStoredPayloadV1;
  }>) => AutomationEncryptedTriggerDefinitionEnvelopeV1;
}>): AutomationPluginEventEncryptedDefinitionTrigger & Readonly<{ enabled: boolean }> {
  const definition = params.trigger;
  const storedDefinition: AutomationEventTriggerDefinitionStoredPayloadV1 = {
    v: 1,
    sourceInstanceId: definition.sourceInstanceId,
    ...(definition.observationTransport.kind === 'durablePush' ? {
      webhookRoutingSourceInstanceId: definition.observationTransport.webhookRoutingSourceInstanceId,
    } : {}),
    sourceConfig: definition.sourceConfig,
    displayLabel: definition.displayLabel,
    filter: definition.filter,
    maximumObservationAgeMs: definition.maximumObservationAgeMs,
  };
  return {
    kind: 'pluginEvent',
    enabled: definition.enabled,
    eventRef: definition.eventRef,
    sourceSelectorId: params.binding.sourceSelectorId,
    sourceContractVersion: definition.sourceContractVersion,
    observationTransport: definition.observationTransport,
    triggerDefinitionEnvelope: params.seal({ binding: params.binding, definition: storedDefinition }),
  };
}

/**
 * The outer stored-content envelope stays canonical. Its plain or encrypted
 * payload is this strict binding wrapper, never a second envelope format.
 */
export const AutomationTriggerDefinitionStoredPayloadV1Schema = z.object({
  v: z.literal(1),
  binding: AutomationTriggerDefinitionBindingV1Schema,
  definition: PluginJsonValueV2Schema,
}).strict();
export type AutomationTriggerDefinitionStoredPayloadV1 = z.infer<
  typeof AutomationTriggerDefinitionStoredPayloadV1Schema
>;

export type AutomationTriggerDefinitionStoredContentOpenFailureV1 =
  | Readonly<{ kind: 'materialUnavailable' }>
  | Readonly<{ kind: 'contentInvalid' }>
  | Readonly<{ kind: 'modeMismatch' }>
  | Readonly<{ kind: 'bindingMismatch' }>;

export type AutomationTriggerDefinitionStoredContentOpenResultV1 =
  | Readonly<{ kind: 'available'; definition: PluginJsonValueV2 }>
  | AutomationTriggerDefinitionStoredContentOpenFailureV1;

export type AutomationTriggerDefinitionStoredContentOuterValidationV1 =
  | Readonly<{
      kind: 'available';
      envelope: AutomationStoredContentEnvelopeV1;
    }>
  | Exclude<AutomationTriggerDefinitionStoredContentOpenFailureV1,
    Readonly<{ kind: 'materialUnavailable' }>>;

type AutomationTriggerDefinitionStoredEnvelopeSealModeV1 =
  | Readonly<{ mode: 'plain' }>
  | Readonly<{
      mode: 'e2ee';
      material: AccountScopedCryptoMaterial;
      randomBytes: (length: number) => Uint8Array;
    }>;

function sameBinding(
  left: AutomationTriggerDefinitionBindingV1,
  right: AutomationTriggerDefinitionBindingV1,
): boolean {
  return left.v === right.v
    && left.automationId === right.automationId
    && left.triggerId === right.triggerId
    && left.triggerRevision === right.triggerRevision
    && left.triggerKind === right.triggerKind
    && (left.triggerKind !== 'pluginEvent' || (right.triggerKind === 'pluginEvent'
      && left.eventRef.pluginId === right.eventRef.pluginId
      && left.eventRef.localId === right.eventRef.localId
      && left.sourceSelectorId === right.sourceSelectorId));
}

/**
 * Lets ciphertext-blind server readers reject cross-purpose Account blobs
 * before returning any opaque definition to a host.
 */
export function isAutomationTriggerDefinitionCiphertextV1(
  ciphertext: string,
): boolean {
  return isAccountScopedBlobCiphertextForKind({
    kind: AUTOMATION_TRIGGER_DEFINITION_ACCOUNT_SCOPED_BLOB_KIND_V1,
    ciphertext,
  });
}

/**
 * Validates the canonical outer envelope at a ciphertext-blind boundary. A
 * plaintext payload is fully bound here; encrypted binding is checked only by
 * the Account-material holder in the matching open helper.
 */
export function validateAutomationTriggerDefinitionStoredEnvelopeOuterForModeV1(
  params: Readonly<{
    mode: 'plain' | 'e2ee';
    binding: AutomationTriggerDefinitionBindingV1;
    envelope: unknown;
  }>,
): AutomationTriggerDefinitionStoredContentOuterValidationV1 {
  const binding = AutomationTriggerDefinitionBindingV1Schema.safeParse(params.binding);
  const envelope = createStoredReadSchema(AutomationStoredContentEnvelopeV1Schema).safeParse(params.envelope);
  if (!binding.success || !envelope.success) return { kind: 'contentInvalid' };
  if (
    (params.mode === 'plain' && envelope.data.t !== 'plain')
    || (params.mode === 'e2ee' && envelope.data.t !== 'encrypted')
  ) {
    return { kind: 'modeMismatch' };
  }
  if (envelope.data.t === 'encrypted') {
    return isAutomationTriggerDefinitionCiphertextV1(envelope.data.c)
      ? { kind: 'available', envelope: envelope.data }
      : { kind: 'contentInvalid' };
  }
  const payload = createStoredReadSchema(AutomationTriggerDefinitionStoredPayloadV1Schema).safeParse(
    envelope.data.v,
  );
  if (!payload.success) return { kind: 'contentInvalid' };
  if (!sameBinding(payload.data.binding, binding.data)) {
    return { kind: 'bindingMismatch' };
  }
  return { kind: 'available', envelope: envelope.data };
}

export function sealAutomationTriggerDefinitionStoredEnvelopeV1(params: Readonly<{
  binding: AutomationTriggerDefinitionBindingV1;
  definition: PluginJsonValueV2;
}> & AutomationTriggerDefinitionStoredEnvelopeSealModeV1): AutomationStoredContentEnvelopeV1 {
  const payload = AutomationTriggerDefinitionStoredPayloadV1Schema.parse({
    v: 1,
    binding: params.binding,
    definition: params.definition,
  });
  if (params.mode === 'plain') {
    return AutomationStoredContentEnvelopeV1Schema.parse({ t: 'plain', v: payload });
  }
  return AutomationStoredContentEnvelopeV1Schema.parse({
    t: 'encrypted',
    c: sealAccountScopedBlobCiphertext({
      kind: AUTOMATION_TRIGGER_DEFINITION_ACCOUNT_SCOPED_BLOB_KIND_V1,
      material: params.material,
      payload,
      randomBytes: params.randomBytes,
    }),
  });
}

/**
 * The only Automation definition decrypting reader. It checks the purpose
 * byte, required wrapper fields, and exact row binding before revealing inner facts.
 */
export function openAutomationTriggerDefinitionStoredEnvelopeV1(params: Readonly<{
  mode: 'plain' | 'e2ee';
  binding: AutomationTriggerDefinitionBindingV1;
  envelope: unknown;
  material?: AccountScopedCryptoMaterial;
}>): AutomationTriggerDefinitionStoredContentOpenResultV1 {
  const binding = AutomationTriggerDefinitionBindingV1Schema.safeParse(params.binding);
  if (!binding.success) return { kind: 'contentInvalid' };
  const outer = validateAutomationTriggerDefinitionStoredEnvelopeOuterForModeV1({
    mode: params.mode,
    binding: binding.data,
    envelope: params.envelope,
  });
  if (outer.kind !== 'available') return outer;

  let rawPayload: unknown;
  if (outer.envelope.t === 'plain') {
    rawPayload = outer.envelope.v;
  } else {
    if (!params.material) return { kind: 'materialUnavailable' };
    const opened = openAccountScopedBlobCiphertext({
      kind: AUTOMATION_TRIGGER_DEFINITION_ACCOUNT_SCOPED_BLOB_KIND_V1,
      material: params.material,
      ciphertext: outer.envelope.c,
    });
    if (!opened) return { kind: 'contentInvalid' };
    rawPayload = opened.value;
  }
  const payload = createStoredReadSchema(AutomationTriggerDefinitionStoredPayloadV1Schema).safeParse(rawPayload);
  if (!payload.success) return { kind: 'contentInvalid' };
  if (!sameBinding(payload.data.binding, binding.data)) {
    return { kind: 'bindingMismatch' };
  }
  return { kind: 'available', definition: payload.data.definition };
}
