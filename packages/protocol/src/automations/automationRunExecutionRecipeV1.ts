import { z } from 'zod';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import {
  AutomationConversationOccurrenceEvidenceV1Schema,
  AutomationPluginEventOccurrenceEvidenceV1Schema,
  AutomationOccurrenceKeyV1Schema,
  AutomationSourceSelectorIdV1Schema,
  deriveAutomationOccurrenceKeyV1,
} from './automationOccurrenceV1.js';
import { AutomationEventPositiveSafeIntegerV1Schema } from './automationEventDeclarationV1.js';
import { AutomationAccountCurrentnessWitnessV1Schema } from './automationAccountCurrentnessV1.js';
import {
  AutomationEventPayloadV1Schema,
  AutomationEventSourceInstanceIdV1Schema,
} from './automationEventJsonBoundsV1.js';
import {
  AutomationStoredContentEnvelopeV1Schema,
  MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES,
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
} from './automationStoredContentEnvelopeV1.js';
import {
  ExecutionRunDetachedStartRequestV1Schema,
  ExecutionRunStartRequestSchema,
  type ExecutionRunStartRequest,
} from '../execution/runs/startRequest.js';
import {
  MENTION_BOUNDS,
  MentionRefV1Schema,
  admitMentionRefsV1ForText,
  type MentionRefV1,
} from '../runtime/input/mentionRefV1.js';
import { SessionIdSchema } from '../sessions/idsV1.js';
// Imported from the draft owner rather than the session-start module: the
// latter reaches Account-scoped crypto, which the browser-realm Action catalog
// closure must not pull in through this recipe.
import {
  SessionServerStartSpawnDraftV1Schema,
  type SessionServerStartSpawnDraftV1,
} from '../sessions/creation/sessionSpawnNewInputV2.js';
import {
  SessionSpawnNewInputV2Schema,
  type SessionSpawnNewInputV2,
} from '../sessions/creation/sessionSpawnNewInputV2.js';

const UTF8_ENCODER = new TextEncoder();
const TIMESTAMP_SCHEMA = z.number().int().nonnegative().safe();
const AUTOMATION_RUN_ID_SCHEMA = z.string().trim().min(1).max(256);

function addUtf8LimitIssue(params: Readonly<{
  value: string;
  maxBytes: number;
  context: z.RefinementCtx;
  message: string;
}>): void {
  if (UTF8_ENCODER.encode(params.value).byteLength > params.maxBytes) {
    params.context.addIssue({ code: z.ZodIssueCode.custom, message: params.message });
  }
}

/**
 * The private, separately rendered prompt program retained by an Automation
 * Run. Execution-target facts belong to the target arm rather than this
 * program, so a rendered prompt cannot rewrite target authority.
 */
export const AutomationRunTemplateV1Schema = z.object({
  v: z.literal(1),
  prompt: z.string().superRefine((value, context) => {
    addUtf8LimitIssue({
      value,
      maxBytes: MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES,
      context,
      message: 'Automation template prompt exceeds its UTF-8 byte limit',
    });
  }),
  /**
   * The composer references this program carries, in the one canonical
   * identity-only shape every other send path persists (`MentionRefV1`). It is
   * additive and optional: a template authored before this field, or by a
   * surface with no reference picker, parses unchanged. Nothing here is
   * provider context — that is still reconstructed at dispatch (D-3/INV-9).
   */
  mentions: z.array(MentionRefV1Schema).max(MENTION_BOUNDS.maxPerMessage).optional(),
}).strict();
export type AutomationRunTemplateV1 = z.infer<typeof AutomationRunTemplateV1Schema>;

/**
 * The immutable private Event evidence consumed by the one Run materializer.
 * Its payload reuses the Event-admission bound, so decoded JSON allocation is
 * bounded before a repeated template token can expand it.
 */
export const AutomationRunPluginEventTriggerEvidenceV1Schema =
  AutomationPluginEventOccurrenceEvidenceV1Schema.extend({
    payload: asProtocolZod(AutomationEventPayloadV1Schema),
    sourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
    sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
    observationReceivedAt: z.number().int().nonnegative().safe(),
    filter: z.object({
      version: z.literal(1).nullable(),
      result: z.literal('matched'),
    }).strict(),
  }).strict();
export type AutomationRunPluginEventTriggerEvidenceV1 = z.infer<
  typeof AutomationRunPluginEventTriggerEvidenceV1Schema
>;

export const AutomationRunConversationTriggerEvidenceV1Schema =
  AutomationConversationOccurrenceEvidenceV1Schema.extend({
    observationReceivedAt: z.number().int().nonnegative().safe(),
  }).strict();
export type AutomationRunConversationTriggerEvidenceV1 = z.infer<
  typeof AutomationRunConversationTriggerEvidenceV1Schema
>;

export const AutomationRunTriggerEvidenceV1Schema = z.discriminatedUnion('kind', [
  AutomationRunPluginEventTriggerEvidenceV1Schema,
  AutomationRunConversationTriggerEvidenceV1Schema,
]);
export type AutomationRunTriggerEvidenceV1 = z.infer<
  typeof AutomationRunTriggerEvidenceV1Schema
>;

/**
 * Why one frozen prompt program could not be materialized. Execution surfaces
 * this as the Run failure detail, so the offending token travels with the
 * refusal instead of being re-derived by a second parser.
 */
export type AutomationRunPromptMaterializationRefusalV1 =
  | Readonly<{ reason: 'templateInvalid' }>
  | Readonly<{ reason: 'triggerEvidenceInvalid' }>
  | Readonly<{ reason: 'malformedToken' }>
  | Readonly<{ reason: 'unsupportedToken'; token: string }>
  | Readonly<{ reason: 'materializedInputTooLarge' }>;

export type AutomationRunPromptMaterializationResultV1 =
  | Readonly<{ kind: 'available'; prompt: string; mentions: readonly MentionRefV1[] }>
  | (Readonly<{ kind: 'contentInvalid' }> & AutomationRunPromptMaterializationRefusalV1);

function encodeAutomationInputData(value: string): string {
  return value
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

function renderPluginEventInput(
  evidence: AutomationRunPluginEventTriggerEvidenceV1,
): string {
  return [
    '<automation_input v="1">',
    'origin_kind="pluginEvent"',
    `event_plugin_id=${encodeAutomationInputData(JSON.stringify(evidence.eventRef.pluginId))}`,
    `event_local_id=${encodeAutomationInputData(JSON.stringify(evidence.eventRef.localId))}`,
    `source_selector_id=${encodeAutomationInputData(JSON.stringify(evidence.sourceSelectorId))}`,
    `source_instance_id=${encodeAutomationInputData(JSON.stringify(evidence.sourceInstanceId))}`,
    `source_contract_version=${evidence.sourceContractVersion}`,
    `occurrence_id=${encodeAutomationInputData(JSON.stringify(evidence.occurrenceId))}`,
    `occurred_at=${evidence.occurredAt}`,
    `observation_received_at=${evidence.observationReceivedAt}`,
    `filter_version=${evidence.filter.version === null ? 'null' : evidence.filter.version}`,
    `filter_result=${encodeAutomationInputData(JSON.stringify(evidence.filter.result))}`,
    `payload_json=${encodeAutomationInputData(createCanonicalJsonSigningInput(evidence.payload))}`,
    '</automation_input>',
  ].join('\n');
}

function renderConversationInput(
  evidence: AutomationRunConversationTriggerEvidenceV1,
): string {
  return [
    '<automation_input v="1">',
    'origin_kind="conversation"',
    `binding_id=${encodeAutomationInputData(JSON.stringify(evidence.bindingId))}`,
    `occurrence_id=${encodeAutomationInputData(JSON.stringify(evidence.occurrenceId))}`,
    `occurred_at=${evidence.occurredAt}`,
    `observation_received_at=${evidence.observationReceivedAt}`,
    `input_json=${encodeAutomationInputData(createCanonicalJsonSigningInput(evidence.input))}`,
    `reply_context_identity=${encodeAutomationInputData(JSON.stringify(evidence.replyContextIdentity))}`,
    '</automation_input>',
  ].join('\n');
}

function renderAutomationInput(evidence: AutomationRunTriggerEvidenceV1 | null): string {
  if (evidence === null) return '';
  return evidence.kind === 'pluginEvent'
    ? renderPluginEventInput(evidence)
    : renderConversationInput(evidence);
}

type ParsedTemplateProgram =
  | Readonly<{ kind: 'parsed'; inputTokenCount: number; literalUtf8Bytes: number }>
  | Readonly<{ kind: 'malformedToken' }>
  | Readonly<{ kind: 'unsupportedToken'; token: string }>;

function parseTemplateProgram(prompt: string): ParsedTemplateProgram {
  let cursor = 0;
  let inputTokenCount = 0;
  let literalUtf8Bytes = 0;

  while (cursor < prompt.length) {
    const opening = prompt.indexOf('{{', cursor);
    const closing = prompt.indexOf('}}', cursor);
    if (closing !== -1 && (opening === -1 || closing < opening)) {
      return { kind: 'malformedToken' };
    }
    if (opening === -1) {
      literalUtf8Bytes += UTF8_ENCODER.encode(prompt.slice(cursor)).byteLength;
      break;
    }

    literalUtf8Bytes += UTF8_ENCODER.encode(prompt.slice(cursor, opening)).byteLength;
    const tokenClosing = prompt.indexOf('}}', opening + 2);
    if (tokenClosing === -1) return { kind: 'malformedToken' };
    const token = prompt.slice(opening, tokenClosing + 2);
    if (token !== '{{input}}') return { kind: 'unsupportedToken', token };
    inputTokenCount += 1;
    cursor = tokenClosing + 2;
  }

  return { kind: 'parsed', inputTokenCount, literalUtf8Bytes };
}

function renderTemplateProgram(params: Readonly<{
  prompt: string;
  input: string;
}>): string {
  return params.prompt.replaceAll('{{input}}', params.input);
}

/**
 * The sole token materializer for frozen Automation Run prompt programs. It
 * parses and bounds the program before repeated substitution can allocate a
 * large output; Event and Conversation values remain data inside a delimited
 * input block and never choose target or permission authority.
 */
export function materializeAutomationRunPromptV1(params: Readonly<{
  template: unknown;
  triggerEvidence: unknown | null;
}>): AutomationRunPromptMaterializationResultV1 {
  const template = AutomationRunTemplateV1Schema.safeParse(params.template);
  if (!template.success) return { kind: 'contentInvalid', reason: 'templateInvalid' };

  const triggerEvidence = params.triggerEvidence === null
    ? null
    : AutomationRunTriggerEvidenceV1Schema.safeParse(params.triggerEvidence);
  if (triggerEvidence !== null && !triggerEvidence.success) {
    return { kind: 'contentInvalid', reason: 'triggerEvidenceInvalid' };
  }

  const input = renderAutomationInput(triggerEvidence?.data ?? null);
  const program = parseTemplateProgram(template.data.prompt);
  if (program.kind === 'malformedToken') {
    return { kind: 'contentInvalid', reason: 'malformedToken' };
  }
  if (program.kind === 'unsupportedToken') {
    return { kind: 'contentInvalid', reason: 'unsupportedToken', token: program.token };
  }

  const inputUtf8Bytes = UTF8_ENCODER.encode(input).byteLength;
  const appendInput = input.length > 0 && program.inputTokenCount === 0;
  const outputUtf8Bytes = program.literalUtf8Bytes
    + (program.inputTokenCount * inputUtf8Bytes)
    + (appendInput ? inputUtf8Bytes + 2 : 0);
  if (outputUtf8Bytes > MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES) {
    return { kind: 'contentInvalid', reason: 'materializedInputTooLarge' };
  }

  const rendered = renderTemplateProgram({ prompt: template.data.prompt, input });
  const prompt = appendInput
    ? (rendered.length > 0 ? `${rendered}\n\n${input}` : input)
    : rendered;
  if (UTF8_ENCODER.encode(prompt).byteLength > MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES) {
    return { kind: 'contentInvalid', reason: 'materializedInputTooLarge' };
  }
  // The same composed admission step every other send path uses: a reference
  // whose token the rendered program no longer contains is dropped, and its
  // siblings survive. Token substitution is a text transform like any other,
  // so this owner must not re-implement the rule.
  return {
    kind: 'available',
    prompt,
    mentions: admitMentionRefsV1ForText(prompt, template.data.mentions ?? []),
  };
}

/**
 * The durable Run origin retained outside the private recipe. It is deliberately
 * small: source payload and raw source identity remain inside the independently
 * protected trigger-evidence envelope.
 */
export const AutomationRunExecutionRecipeOriginV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('scheduled'),
    scheduledFor: TIMESTAMP_SCHEMA,
  }).strict(),
  z.object({
    kind: z.literal('manual'),
    invokedAt: TIMESTAMP_SCHEMA,
  }).strict(),
  z.object({
    kind: z.literal('pluginEvent'),
    occurrenceKey: AutomationOccurrenceKeyV1Schema,
    sourceSelectorId: AutomationSourceSelectorIdV1Schema,
    occurredAt: TIMESTAMP_SCHEMA,
  }).strict(),
  z.object({
    kind: z.literal('conversation'),
    occurrenceKey: AutomationOccurrenceKeyV1Schema,
    occurredAt: TIMESTAMP_SCHEMA,
  }).strict(),
]);
export type AutomationRunExecutionRecipeOriginV1 = z.infer<
  typeof AutomationRunExecutionRecipeOriginV1Schema
>;

export const AutomationRunExecutionTargetV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('existingSession'),
    sessionId: asProtocolZod(SessionIdSchema),
  }).strict(),
  z.object({
    kind: z.literal('newSession'),
    spawn: SessionServerStartSpawnDraftV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('executionRun'),
    request: ExecutionRunDetachedStartRequestV1Schema,
  }).strict(),
]);
export type AutomationRunExecutionTargetV1 = z.infer<typeof AutomationRunExecutionTargetV1Schema>;

/**
 * Whether a target hands the Run's composer references to its dispatch owner.
 *
 * Only the existing-Session target reaches a structured-input seam: its effect
 * is a Session message, which already carries `happierStructuredInputV1` beside
 * the text. The new-Session spawn draft and the detached execution-Run request
 * carry a bare instruction string and have no reference field, so a reference
 * stored for them would be persisted and then dropped.
 *
 * Authoring surfaces read this instead of restating the target list, so a
 * writer's refusal cannot drift from what
 * `materializeAutomationRunExecutionRecipeV1` actually delivers.
 */
export function automationRunExecutionTargetDeliversComposerReferencesV1(
  kind: AutomationRunExecutionTargetV1['kind'],
): boolean {
  return kind === 'existingSession';
}

/**
 * The sole current durable execution-input shape. Account currentness stays
 * beside this recipe because claim/start publication advances Account.seq;
 * the pair of private envelopes remains mode-checked against that witness at
 * every owner boundary.
 */
export const AutomationRunExecutionRecipeV1Schema = z.object({
  v: z.literal(1),
  templateVersion: z.number().int().nonnegative().safe(),
  template: AutomationStoredContentEnvelopeV1Schema,
  triggerEvidence: AutomationStoredContentEnvelopeV1Schema.nullable(),
  target: AutomationRunExecutionTargetV1Schema,
}).strict().superRefine((value, context) => {
  addUtf8LimitIssue({
    value: createCanonicalJsonSigningInput(value),
    // The recipe retains independently bounded opaque envelopes. Its framing
    // therefore uses the persisted-envelope ceiling; the separate prompt and
    // target requests stay at the narrower materialized-input ceiling.
    maxBytes: MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
    context,
    message: 'Automation Run execution recipe exceeds its UTF-8 byte limit',
  });
});
export type AutomationRunExecutionRecipeV1 = z.infer<typeof AutomationRunExecutionRecipeV1Schema>;

/**
 * The one stored-definition projection of the current recipe. A definition
 * carries no occurrence evidence: admission freezes that onto the Run. Every
 * definition authoring surface — the account-owner V3 route and the plugin
 * Conversation target Action — parses through this single owner.
 */
export const AutomationStoredDefinitionExecutionRecipeV1Schema =
  AutomationRunExecutionRecipeV1Schema.superRefine((value, context) => {
    if (value.triggerEvidence !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['triggerEvidence'],
        message: 'A stored Automation definition cannot carry Run occurrence evidence',
      });
    }
  });
export type AutomationStoredDefinitionExecutionRecipeV1 = z.infer<
  typeof AutomationStoredDefinitionExecutionRecipeV1Schema
>;

export type AutomationRunExecutionRecipeSerializedV1Result =
  | Readonly<{
    kind: 'available';
    recipe: AutomationRunExecutionRecipeV1;
    serialized: string;
  }>
  | Readonly<{ kind: 'contentInvalid' }>;

/**
 * The canonical persistence parser for a frozen Automation recipe. Callers do
 * not JSON.parse recipe bytes themselves: this keeps strict shape, decoded
 * allocation, and UTF-8 framing limits at the Protocol owner.
 */
export function parseAutomationRunExecutionRecipeV1(
  serialized: unknown,
): AutomationRunExecutionRecipeSerializedV1Result {
  if (
    typeof serialized !== 'string'
    || UTF8_ENCODER.encode(serialized).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES
  ) {
    return { kind: 'contentInvalid' };
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return { kind: 'contentInvalid' };
  }
  const recipe = AutomationRunExecutionRecipeV1Schema.safeParse(value);
  if (!recipe.success) return { kind: 'contentInvalid' };
  return { kind: 'available', recipe: recipe.data, serialized };
}

/** Writes one canonical strict recipe representation for durable storage. */
export function serializeAutomationRunExecutionRecipeV1(
  recipe: unknown,
): AutomationRunExecutionRecipeSerializedV1Result {
  const parsed = AutomationRunExecutionRecipeV1Schema.safeParse(recipe);
  if (!parsed.success) return { kind: 'contentInvalid' };
  const serialized = createCanonicalJsonSigningInput(parsed.data);
  return UTF8_ENCODER.encode(serialized).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES
    ? { kind: 'contentInvalid' }
    : { kind: 'available', recipe: parsed.data, serialized };
}

export type FreezeAutomationRunPluginEventExecutionRecipeV1Result =
  | Readonly<{
    kind: 'available';
    recipe: AutomationRunExecutionRecipeV1;
    serialized: string;
  }>
  | Readonly<{ kind: 'contentInvalid' }>;

/**
 * The one strict Event-definition-to-Run freezer.  An Event definition is a
 * complete strict recipe with no occurrence evidence; E3 supplies only the
 * mode-correct sealed evidence for this occurrence.  No caller parses or
 * reconstructs the recipe's template or target outside this owner.
 */
export function freezeAutomationRunPluginEventExecutionRecipeV1(params: Readonly<{
  definitionRecipe: unknown;
  templateVersion: number;
  triggerEvidence: unknown;
}>): FreezeAutomationRunPluginEventExecutionRecipeV1Result {
  const definition = parseAutomationRunExecutionRecipeV1(params.definitionRecipe);
  if (
    definition.kind !== 'available'
    || definition.recipe.triggerEvidence !== null
    || definition.recipe.templateVersion !== params.templateVersion
  ) {
    return { kind: 'contentInvalid' };
  }
  const triggerEvidence = AutomationStoredContentEnvelopeV1Schema.safeParse(params.triggerEvidence);
  if (
    !triggerEvidence.success
    || (
      triggerEvidence.data.t === 'plain'
      && !AutomationRunPluginEventTriggerEvidenceV1Schema.safeParse(triggerEvidence.data.v).success
    )
  ) return { kind: 'contentInvalid' };
  const frozen = serializeAutomationRunExecutionRecipeV1({
    ...definition.recipe,
    triggerEvidence: triggerEvidence.data,
  });
  return frozen.kind === 'available'
    ? frozen
    : { kind: 'contentInvalid' };
}

export type AutomationRunExecutionRecipeOuterValidationResultV1 =
  | Readonly<{ kind: 'available'; recipe: AutomationRunExecutionRecipeV1 }>
  | Readonly<{ kind: 'contentInvalid' }>;

/**
 * A routed detail reader needs to distinguish strict recipe framing that is
 * invalid from framing that is valid but belongs to a different Account mode.
 * Execution retains its established content-invalid result below.
 */
export type AutomationRunExecutionRecipeOuterInspectionResultV1 =
  | Readonly<{ kind: 'available'; recipe: AutomationRunExecutionRecipeV1 }>
  | Readonly<{ kind: 'modeMismatch' }>
  | Readonly<{ kind: 'contentInvalid' }>;

function envelopeMatchesCurrentness(
  envelope: AutomationRunExecutionRecipeV1['template'],
  currentness: z.infer<typeof AutomationAccountCurrentnessWitnessV1Schema>,
): boolean {
  return currentness.mode === 'plain'
    ? envelope.t === 'plain'
    : envelope.t === 'encrypted';
}

/**
 * Parses the unencrypted recipe framing and verifies that each private content
 * envelope has the Account mode currently under custody. Decryption and
 * content-key proof remain with the canonical Account encryption owner.
 */
export function inspectAutomationRunExecutionRecipeOuterV1(params: Readonly<{
  recipe: unknown;
  accountCurrentness: unknown;
}>): AutomationRunExecutionRecipeOuterInspectionResultV1 {
  const recipe = AutomationRunExecutionRecipeV1Schema.safeParse(params.recipe);
  const accountCurrentness = AutomationAccountCurrentnessWitnessV1Schema.safeParse(
    params.accountCurrentness,
  );
  if (!recipe.success || !accountCurrentness.success) {
    return { kind: 'contentInvalid' };
  }
  if (
    !envelopeMatchesCurrentness(recipe.data.template, accountCurrentness.data)
    || (
      recipe.data.triggerEvidence !== null
      && !envelopeMatchesCurrentness(recipe.data.triggerEvidence, accountCurrentness.data)
    )
  ) {
    return { kind: 'modeMismatch' };
  }
  return { kind: 'available', recipe: recipe.data };
}

/**
 * Execution cannot dispatch either invalid or mode-mismatched bytes. Preserve
 * that legacy contract while giving read-only detail consumers the exact
 * unavailable reason through inspectAutomationRunExecutionRecipeOuterV1.
 */
export function validateAutomationRunExecutionRecipeOuterV1(params: Readonly<{
  recipe: unknown;
  accountCurrentness: unknown;
}>): AutomationRunExecutionRecipeOuterValidationResultV1 {
  const inspected = inspectAutomationRunExecutionRecipeOuterV1(params);
  return inspected.kind === 'available'
    ? inspected
    : { kind: 'contentInvalid' };
}

export type AutomationRunOpenedExecutionRecipeContentV1 = Readonly<{
  template: unknown;
  triggerEvidence: unknown | null;
}>;

const AutomationRunOpenedExecutionRecipeContentV1Schema = z.object({
  template: z.unknown(),
  triggerEvidence: z.unknown().nullable(),
}).strict();

type ReadRecipeContentResult =
  | Readonly<{ kind: 'available'; content: AutomationRunOpenedExecutionRecipeContentV1 }>
  | Readonly<{ kind: 'contentInvalid' }>
  | Readonly<{ kind: 'materialUnavailable' }>;

function readRecipeContent(params: Readonly<{
  recipe: AutomationRunExecutionRecipeV1;
  openedContent: unknown | undefined;
}>): ReadRecipeContentResult {
  if (params.recipe.template.t === 'plain') {
    if (
      params.recipe.triggerEvidence !== null
      && params.recipe.triggerEvidence.t !== 'plain'
    ) {
      return { kind: 'contentInvalid' };
    }
    return {
      kind: 'available',
      content: {
        template: params.recipe.template.v,
        triggerEvidence: params.recipe.triggerEvidence?.v ?? null,
      },
    };
  }
  if (params.recipe.triggerEvidence !== null && params.recipe.triggerEvidence.t !== 'encrypted') {
    return { kind: 'contentInvalid' };
  }
  if (params.openedContent === undefined) return { kind: 'materialUnavailable' };
  const openedContent = AutomationRunOpenedExecutionRecipeContentV1Schema.safeParse(params.openedContent);
  return openedContent.success
    ? { kind: 'available', content: openedContent.data }
    : { kind: 'contentInvalid' };
}

function matchesOriginEvidence(
  origin: AutomationRunExecutionRecipeOriginV1,
  triggerEvidence: AutomationRunTriggerEvidenceV1 | null,
): boolean {
  switch (origin.kind) {
    case 'scheduled':
    case 'manual':
      return triggerEvidence === null;
    case 'pluginEvent':
      return triggerEvidence?.kind === 'pluginEvent'
        && triggerEvidence.sourceSelectorId === origin.sourceSelectorId
        && triggerEvidence.occurredAt === origin.occurredAt
        && deriveAutomationOccurrenceKeyV1({
          v: triggerEvidence.v,
          kind: triggerEvidence.kind,
          eventRef: triggerEvidence.eventRef,
          sourceSelectorId: triggerEvidence.sourceSelectorId,
          occurrenceId: triggerEvidence.occurrenceId,
          occurredAt: triggerEvidence.occurredAt,
          payload: triggerEvidence.payload,
        }) === origin.occurrenceKey;
    case 'conversation':
      return triggerEvidence?.kind === 'conversation'
        && triggerEvidence.occurredAt === origin.occurredAt
        && deriveAutomationOccurrenceKeyV1({
          v: triggerEvidence.v,
          kind: triggerEvidence.kind,
          bindingId: triggerEvidence.bindingId,
          occurrenceId: triggerEvidence.occurrenceId,
          occurredAt: triggerEvidence.occurredAt,
          caller: triggerEvidence.caller,
          input: triggerEvidence.input,
          replyContextIdentity: triggerEvidence.replyContextIdentity,
        }) === origin.occurrenceKey;
  }
}

export type AutomationRunExecutionRecipeMaterializationResultV1 =
  | Readonly<{
    kind: 'available';
    target:
      | Readonly<{
        kind: 'existingSession';
        sessionId: string;
        prompt: string;
        mentions: readonly MentionRefV1[];
      }>
      | Readonly<{ kind: 'newSession'; spawn: SessionSpawnNewInputV2 }>
      | Readonly<{ kind: 'executionRun'; request: ExecutionRunStartRequest }>;
  }>
  | Readonly<{ kind: 'contentInvalid' }>
  | Readonly<{ kind: 'materialUnavailable' }>;

/**
 * Materializes one exact effect request from a frozen recipe. It never opens
 * ciphertext itself: callers provide encrypted plaintext only after the
 * canonical Account owner has verified the same envelope under the current
 * witness. Plain content is always read directly from the persisted envelope.
 */
export function materializeAutomationRunExecutionRecipeV1(params: Readonly<{
  recipe: unknown;
  origin: unknown;
  accountCurrentness: unknown;
  runId: unknown;
  openedContent?: unknown;
}>): AutomationRunExecutionRecipeMaterializationResultV1 {
  const outer = validateAutomationRunExecutionRecipeOuterV1({
    recipe: params.recipe,
    accountCurrentness: params.accountCurrentness,
  });
  if (outer.kind !== 'available') return outer;
  const origin = AutomationRunExecutionRecipeOriginV1Schema.safeParse(params.origin);
  const runId = AUTOMATION_RUN_ID_SCHEMA.safeParse(params.runId);
  if (!origin.success || !runId.success) return { kind: 'contentInvalid' };

  const content = readRecipeContent({
    recipe: outer.recipe,
    openedContent: params.openedContent,
  });
  if (content.kind !== 'available') return content;
  const template = AutomationRunTemplateV1Schema.safeParse(content.content.template);
  const triggerEvidence = content.content.triggerEvidence === null
    ? null
    : AutomationRunTriggerEvidenceV1Schema.safeParse(content.content.triggerEvidence);
  if (!template.success || (triggerEvidence !== null && !triggerEvidence.success)) {
    return { kind: 'contentInvalid' };
  }
  const parsedEvidence = triggerEvidence?.data ?? null;
  if (!matchesOriginEvidence(origin.data, parsedEvidence)) return { kind: 'contentInvalid' };

  const prompt = materializeAutomationRunPromptV1({
    template: template.data,
    triggerEvidence: parsedEvidence,
  });
  if (prompt.kind !== 'available') return { kind: 'contentInvalid' };

  switch (outer.recipe.target.kind) {
    case 'existingSession':
      return {
        kind: 'available',
        target: {
          kind: 'existingSession',
          sessionId: outer.recipe.target.sessionId,
          prompt: prompt.prompt,
          mentions: prompt.mentions,
        },
      };
    case 'newSession': {
      const spawn = SessionSpawnNewInputV2Schema.safeParse({
        ...outer.recipe.target.spawn,
        creationKey: `automation-run:${runId.data}`,
        initialMessage: prompt.prompt,
      });
      return spawn.success
        ? { kind: 'available', target: { kind: 'newSession', spawn: spawn.data } }
        : { kind: 'contentInvalid' };
    }
    case 'executionRun': {
      const request = ExecutionRunStartRequestSchema.safeParse({
        ...outer.recipe.target.request,
        instructions: prompt.prompt,
        intentInput: {},
      });
      return request.success
        ? { kind: 'available', target: { kind: 'executionRun', request: request.data } }
        : { kind: 'contentInvalid' };
    }
  }
}
