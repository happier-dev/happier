import { hmac } from '@noble/hashes/hmac';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import { sha256 } from '@noble/hashes/sha2';
import { z } from 'zod';

import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import {
  computeCanonicalDomainSeparatedDigest,
  encodeCanonicalLengthDelimited,
} from '../crypto/canonicalDigest.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
} from '../plugins/contributionIdentity.js';
import {
  PluginJsonValueV2Schema,
} from '../plugins/contributions/publicTypes.js';
import { PluginMachineMaterializationMachineIdV1Schema } from '../plugins/availability/materializationRefV1.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import {
  AutomationHostIdentifierV1Schema,
  AutomationIdV1Schema,
} from './automationIdV1.js';
import {
  AutomationEventPayloadV1Schema,
  AutomationEventSourceOrOccurrenceIdV1Schema,
} from './automationEventJsonBoundsV1.js';
import {
  AutomationOriginOccurredAtV1Schema,
} from './automationOriginOccurredAtV1.js';
// Type-only: the reply-context identity commits to the admitted delivery arm
// without this occurrence owner depending on the delivery module at runtime.
import type { AutomationConversationResultDeliveryV1 } from './automationResultDeliveryV1.js';
import {
  AutomationSourceSelectorIdV1JsonSchema,
  AutomationSourceSelectorIdV1Schema,
  type AutomationSourceSelectorIdV1,
} from './automationEventDeclarationV1.js';

export {
  AutomationSourceSelectorIdV1JsonSchema,
  AutomationSourceSelectorIdV1Schema,
  type AutomationSourceSelectorIdV1,
} from './automationEventDeclarationV1.js';
export {
  AutomationOriginOccurredAtV1Schema,
  MAX_AUTOMATION_ORIGIN_OCCURRED_AT_MS,
} from './automationOriginOccurredAtV1.js';
export type { AutomationOriginOccurredAtV1 } from './automationOriginOccurredAtV1.js';

export const AUTOMATION_OCCURRENCE_KEY_DOMAIN_V1 =
  'happier.automation-occurrence.v1' as const;
export const AUTOMATION_OCCURRENCE_EQUALITY_DOMAIN_V1 =
  'happier.automation-occurrence-equality.v1' as const;
export const AUTOMATION_MANUAL_OCCURRENCE_KEY_DOMAIN_V1 =
  'happier.automation-manual-occurrence.v1' as const;

const UTF8_ENCODER = new TextEncoder();
function boundedNfcString(maxUtf8Bytes: number, label: string) {
  return z.string().trim().min(1).superRefine((value, context) => {
    if (value !== value.normalize('NFC')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must be NFC-normalized`,
      });
    }
    if (UTF8_ENCODER.encode(value).byteLength > maxUtf8Bytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} exceeds its UTF-8 byte limit`,
      });
    }
  });
}

const OCCURRENCE_ID_SCHEMA = AutomationEventSourceOrOccurrenceIdV1Schema;
export const AutomationConversationBindingIdV1Schema = boundedNfcString(
  256,
  'Conversation binding identifiers',
);
/**
 * Immutable logical caller identity retained with a Conversation occurrence.
 * Materialization and generation are intentionally excluded: they are
 * currentness facts at admission, not rejoin identity across a rollover.
 */
export const AutomationConversationAdmissionCallerIdentityV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  machineId: PluginMachineMaterializationMachineIdV1Schema,
}).strict();
export type AutomationConversationAdmissionCallerIdentityV1 = z.infer<
  typeof AutomationConversationAdmissionCallerIdentityV1Schema
>;
const BASE64_URL_SHA_256_SCHEMA = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
  .refine((value) => {
    try {
      const decoded = decodeBase64(value, 'base64url');
      return decoded.byteLength === 32 && encodeBase64(decoded, 'base64url') === value;
    } catch {
      return false;
    }
  }, 'Expected one canonical unpadded base64url SHA-256 value');

export const AutomationOccurrenceKeyV1Schema = BASE64_URL_SHA_256_SCHEMA.brand<
  'AutomationOccurrenceKeyV1'
>();
export type AutomationOccurrenceKeyV1 = z.infer<typeof AutomationOccurrenceKeyV1Schema>;

export const AutomationManualIdempotencyKeyV1Schema = boundedNfcString(
  191,
  'Manual idempotency keys',
);
export type AutomationManualIdempotencyKeyV1 = z.infer<
  typeof AutomationManualIdempotencyKeyV1Schema
>;

/** Maps a caller occurrence identity into the existing durable Run occurrence key. */
export function deriveAutomationManualOccurrenceKeyV1(params: Readonly<{
  automationId: z.input<typeof AutomationIdV1Schema>;
  idempotencyKey: z.input<typeof AutomationManualIdempotencyKeyV1Schema>;
}>): AutomationOccurrenceKeyV1 {
  return AutomationOccurrenceKeyV1Schema.parse(
    computeCanonicalDomainSeparatedDigest(
      AUTOMATION_MANUAL_OCCURRENCE_KEY_DOMAIN_V1,
      [
        '1',
        AutomationIdV1Schema.parse(params.automationId),
        AutomationManualIdempotencyKeyV1Schema.parse(params.idempotencyKey),
      ],
    ),
  );
}

export const AutomationOccurrenceEvidenceEqualityTagV1Schema =
  BASE64_URL_SHA_256_SCHEMA.brand<'AutomationOccurrenceEvidenceEqualityTagV1'>();
export type AutomationOccurrenceEvidenceEqualityTagV1 = z.infer<
  typeof AutomationOccurrenceEvidenceEqualityTagV1Schema
>;

export const AutomationPluginEventOccurrenceEvidenceV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('pluginEvent'),
  eventRef: asProtocolZod(PluginContributionIdentityV1Schema),
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  occurrenceId: OCCURRENCE_ID_SCHEMA,
  occurredAt: AutomationOriginOccurredAtV1Schema,
  payload: asProtocolZod(AutomationEventPayloadV1Schema),
}).strict();
export type AutomationPluginEventOccurrenceEvidenceV1 = z.infer<
  typeof AutomationPluginEventOccurrenceEvidenceV1Schema
>;

/**
 * Creates the sole canonical evidence projection for one Plugin Event
 * occurrence. Hosts use this before either persisting plaintext evidence or
 * sealing E2EE trigger evidence; plugins never supply the envelope shape.
 */
export function buildAutomationPluginEventOccurrenceEvidenceV1(params: Readonly<{
  eventRef: z.input<typeof PluginContributionIdentityV1Schema>;
  sourceSelectorId: z.input<typeof AutomationSourceSelectorIdV1Schema>;
  occurrenceId: z.input<typeof OCCURRENCE_ID_SCHEMA>;
  occurredAt: z.input<typeof AutomationOriginOccurredAtV1Schema>;
  payload: z.input<typeof AutomationEventPayloadV1Schema>;
}>): AutomationPluginEventOccurrenceEvidenceV1 {
  return AutomationPluginEventOccurrenceEvidenceV1Schema.parse({
    v: 1,
    kind: 'pluginEvent',
    ...params,
  });
}

export const AutomationConversationOccurrenceEvidenceV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('conversation'),
  bindingId: AutomationConversationBindingIdV1Schema,
  occurrenceId: OCCURRENCE_ID_SCHEMA,
  occurredAt: AutomationOriginOccurredAtV1Schema,
  caller: AutomationConversationAdmissionCallerIdentityV1Schema,
  input: PluginJsonValueV2Schema,
  replyContextIdentity: boundedNfcString(512, 'Reply-context identities'),
}).strict();
export type AutomationConversationOccurrenceEvidenceV1 = z.infer<
  typeof AutomationConversationOccurrenceEvidenceV1Schema
>;

export const AUTOMATION_CONVERSATION_REPLY_CONTEXT_IDENTITY_DOMAIN_V1 =
  'happier.automation-conversation-reply-context.v1' as const;

/**
 * The opaque reply-context identity retained inside Conversation occurrence
 * evidence. It commits the immutable occurrence to the exact Account mode and
 * delivery arm that was admitted, so occurrence equality still covers the
 * reply handoff for an Account whose evidence the server cannot read.
 */
export function deriveAutomationConversationReplyContextIdentityV1(params: Readonly<{
  accountMode: 'plain' | 'e2ee';
  resultDelivery: AutomationConversationResultDeliveryV1;
}>): string {
  return computeCanonicalDomainSeparatedDigest(
    AUTOMATION_CONVERSATION_REPLY_CONTEXT_IDENTITY_DOMAIN_V1,
    [
      '1',
      params.accountMode,
      createCanonicalJsonSigningInput(params.resultDelivery),
    ],
  );
}

/**
 * Creates the sole canonical evidence projection for one Conversation
 * occurrence. The plain server writer and the E2EE admission host both build
 * it here, so a sealed occurrence and a plaintext one describe the same
 * immutable facts and derive the same occurrence key.
 */
export function buildAutomationConversationOccurrenceEvidenceV1(params: Readonly<{
  accountMode: 'plain' | 'e2ee';
  bindingId: z.input<typeof AutomationConversationBindingIdV1Schema>;
  occurrenceId: z.input<typeof OCCURRENCE_ID_SCHEMA>;
  occurredAt: z.input<typeof AutomationOriginOccurredAtV1Schema>;
  caller: AutomationConversationAdmissionCallerIdentityV1;
  sender: unknown;
  text: string;
  resultDelivery: AutomationConversationResultDeliveryV1;
}>): AutomationConversationOccurrenceEvidenceV1 {
  return AutomationConversationOccurrenceEvidenceV1Schema.parse({
    v: 1,
    kind: 'conversation',
    bindingId: params.bindingId,
    occurrenceId: params.occurrenceId,
    occurredAt: params.occurredAt,
    caller: params.caller,
    input: {
      sender: params.sender,
      text: params.text,
    },
    replyContextIdentity: deriveAutomationConversationReplyContextIdentityV1({
      accountMode: params.accountMode,
      resultDelivery: params.resultDelivery,
    }),
  });
}

export const AutomationOccurrenceEvidenceV1Schema = z.discriminatedUnion('kind', [
  AutomationPluginEventOccurrenceEvidenceV1Schema,
  AutomationConversationOccurrenceEvidenceV1Schema,
]);
export type AutomationOccurrenceEvidenceV1 = z.infer<
  typeof AutomationOccurrenceEvidenceV1Schema
>;

const AutomationOccurrenceEvidenceEqualityInputV1Schema = z.object({
  accountId: asProtocolZod(AutomationHostIdentifierV1Schema),
  automationId: asProtocolZod(AutomationIdV1Schema),
  occurrenceKey: AutomationOccurrenceKeyV1Schema,
  evidence: AutomationOccurrenceEvidenceV1Schema,
}).strict();

function occurrenceKeyParts(
  evidence: AutomationOccurrenceEvidenceV1,
): readonly string[] {
  if (evidence.kind === 'pluginEvent') {
    return [
      '1',
      evidence.kind,
      evidence.eventRef.pluginId,
      evidence.eventRef.localId,
      evidence.sourceSelectorId,
      evidence.occurrenceId,
    ];
  }
  // Mirrors the Plugin Event branch: an occurrence identity is namespaced by
  // the plugin that owns the trigger, so two plugins observing the same
  // conversation binding and occurrence id never collide on one Run.
  return [
    '1',
    evidence.kind,
    evidence.caller.pluginId,
    evidence.bindingId,
    evidence.occurrenceId,
  ];
}

/**
 * The one persisted external-occurrence identity. It deliberately excludes
 * template version, observed time, filters, and payload so a replay of the
 * same provider occurrence rejoins after a definition refresh.
 */
export function deriveAutomationOccurrenceKeyV1(
  input: AutomationOccurrenceEvidenceV1,
): AutomationOccurrenceKeyV1 {
  const evidence = AutomationOccurrenceEvidenceV1Schema.parse(input);
  return AutomationOccurrenceKeyV1Schema.parse(
    computeCanonicalDomainSeparatedDigest(
      AUTOMATION_OCCURRENCE_KEY_DOMAIN_V1,
      occurrenceKeyParts(evidence),
    ),
  );
}

function encodeAutomationOccurrenceEvidenceEqualityInputV1(
  input: z.input<typeof AutomationOccurrenceEvidenceEqualityInputV1Schema>,
): Uint8Array {
  const parsed = AutomationOccurrenceEvidenceEqualityInputV1Schema.parse(input);
  if (parsed.occurrenceKey !== deriveAutomationOccurrenceKeyV1(parsed.evidence)) {
    throw new TypeError('Automation occurrence equality input must use the occurrence key derived from its evidence');
  }
  return encodeCanonicalLengthDelimited([
    AUTOMATION_OCCURRENCE_EQUALITY_DOMAIN_V1,
    '1',
    parsed.accountId,
    parsed.automationId,
    parsed.occurrenceKey,
    createCanonicalJsonSigningInput(parsed.evidence),
  ]);
}

/**
 * Canonical, length-delimited equality input. This is host-only input to the
 * E2EE tag calculation; plugins never provide an equality digest or tag.
 */
export function serializeAutomationOccurrenceEvidenceEqualityV1(
  input: z.input<typeof AutomationOccurrenceEvidenceEqualityInputV1Schema>,
): string {
  return encodeBase64(
    encodeAutomationOccurrenceEvidenceEqualityInputV1(input),
    'base64url',
  );
}

/**
 * Creates the opaque E2EE rejoin tag from a key already purpose-separated by
 * the Account-content owner. The server stores and compares this tag but does
 * not derive it from plugin input or decrypt it as an occurrence identity.
 */
export function deriveAutomationOccurrenceEvidenceEqualityTagV1(
  params: Readonly<{
    purposeSeparatedAccountKey: Uint8Array;
    accountId: string;
    automationId: string;
    occurrenceKey: AutomationOccurrenceKeyV1;
    evidence: AutomationOccurrenceEvidenceV1;
  }>,
): AutomationOccurrenceEvidenceEqualityTagV1 {
  if (!(params.purposeSeparatedAccountKey instanceof Uint8Array)
    || params.purposeSeparatedAccountKey.byteLength !== 32) {
    throw new TypeError('Automation occurrence equality requires one 32-byte purpose-separated Account key');
  }
  const {
    purposeSeparatedAccountKey,
    ...equalityInput
  } = params;
  return AutomationOccurrenceEvidenceEqualityTagV1Schema.parse(
    encodeBase64(
      hmac(
        sha256,
        purposeSeparatedAccountKey,
        encodeAutomationOccurrenceEvidenceEqualityInputV1(equalityInput),
      ),
      'base64url',
    ),
  );
}
