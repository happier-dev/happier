import { z } from 'zod';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import {
  AutomationConversationTargetVerifyInputV1Schema,
  AutomationConversationTargetsListInputV1Schema,
  AutomationEventAdmitHttpInputV1Schema,
  AutomationEventAdmitInputV1Schema,
  AutomationEventFilterV1Schema,
  AutomationEventSourceCatalogStatusStateV1Schema,
  AutomationEventSourceObservationTransportV1Schema,
  AutomationEventSourcesListInputV1Schema,
  AutomationEventSourceStatusCodeV1Schema,
  AutomationEventSourceStatusReportV1Schema,
  AutomationEventSourceStatusStateV1Schema,
  MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL,
  MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE,
  OPAQUE_CURSOR_SCHEMA,
  UNSIGNED_DECIMAL_BIGINT_SCHEMA,
  type AutomationConversationActionIdV1,
  type AutomationEventActionIdV1,
  type AutomationEventFilterV1,
  type AutomationEventSourceObservationTransportV1,
  type AutomationJsonPointerV1,
  type AutomationJsonScalarV1,
} from './automationActionSpecsV1.js';
import {
  isAccountScopedBlobCiphertextForKind,
} from '../crypto/accountScopedCipherEnvelope.js';
import { readCanonicalPaddedBase64DecodedLength } from '../crypto/base64.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import {
  PluginJsonSchemaV2Schema,
  type PluginJsonSchemaV2,
  PluginJsonValueV2Schema,
  type PluginJsonValueV2,
} from '../plugins/contributions/publicTypes.js';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
  normalizePluginJsonSchema,
  type PluginJsonSchemaValidator,
} from '../plugins/actions/jsonSchemaValidation.js';
import {
  PluginMachineMaterializationIdV1Schema,
  PluginMachineMaterializationRefV1Schema,
  type PluginMachineMaterializationRefV1,
} from '../plugins/availability/materializationRefV1.js';
import {
  PluginReleaseRefV1Schema,
} from '../plugins/availability/v1.js';
import { PluginUiArtifactDigestV1Schema } from '../plugins/ui/artifactIntegrity.js';
import { PluginUiImmutableGenerationIdV1Schema } from '../plugins/ui/targetedContributions.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import {
  PluginWebhookEndpointIdV1Schema,
  type PluginWebhookEndpointIdV1,
} from '../plugins/webhooks/endpointV1.js';
import {
  PluginWebhookInvocationReferenceV1Schema,
} from '../plugins/webhooks/deliveryV1.js';

import {
  AutomationOccurrenceEvidenceEqualityTagV1Schema,
  AutomationOccurrenceEvidenceV1Schema,
  AutomationOccurrenceKeyV1Schema,
  type AutomationOccurrenceEvidenceV1,
} from './automationOccurrenceV1.js';
import {
  AutomationHostIdentifierV1Schema as HostIdentifierV1Schema,
  AutomationIdV1Schema,
  type AutomationIdV1,
} from './automationIdV1.js';
import { AutomationAccountCurrentnessWitnessV1Schema } from './automationAccountCurrentnessV1.js';
export { AutomationIdV1Schema };
export type { AutomationIdV1 };
import {
  AutomationEventPositiveSafeIntegerV1Schema as POSITIVE_SAFE_INTEGER_SCHEMA,
  AutomationObservationTransportKindV1Schema,
  AutomationQualifiedPluginContributionRefV1Schema,
  AutomationSourceSelectorIdV1Schema,
  type AutomationSourceSelectorIdV1,
} from './automationEventDeclarationV1.js';
import {
  AutomationEventPayloadV1Schema,
  AutomationEventReplyContextV1Schema,
  AutomationEventSourceConfigV1Schema,
  AutomationEventSourceDisplayLabelV1Schema,
  AutomationEventSourceInstanceIdV1Schema,
} from './automationEventJsonBoundsV1.js';
import { AutomationOriginOccurredAtV1Schema } from './automationOriginOccurredAtV1.js';
import {
  addAutomationStoredEnvelopeUtf8LimitIssue,
  AutomationStoredContentEnvelopeV1Schema,
  ENCRYPTED_STORED_CONTENT_SCHEMA,
  MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES,
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
} from './automationStoredContentEnvelopeV1.js';
// The foundational stored-content envelope and its ceilings moved below this
// module so persistence owners that must not depend on Event contracts can
// reach them. Incumbent importers keep resolving them here.
export {
  AutomationStoredContentEnvelopeV1Schema,
  MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES,
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
};
export type { AutomationStoredContentEnvelopeV1 } from './automationStoredContentEnvelopeV1.js';
import {
  AutomationConversationAdmitInputV1Schema,
  AutomationConversationAdmitResultV1Schema,
  AutomationConversationResultDeliveryV1Schema,
  AutomationNonnegativeSafeIntegerV1Schema as NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  AutomationResultDeliveryActionRefV1Schema,
  AutomationResultDeliveryInputV1JsonSchema,
  AutomationResultDeliveryInputV1Schema,
  AutomationResultDeliveryResultV1JsonSchema,
  AutomationResultDeliveryResultV1Schema,
  AutomationResultDeliverySourceV1JsonSchema,
  AutomationResultDeliverySourceV1Schema,
  AutomationRunResultV1JsonSchema,
  AutomationRunResultV1Schema,
  isAutomationConversationResultDeliveryOwnedByCallerV1,
  MAX_AUTOMATION_CONVERSATION_ADMIT_TEXT_UTF8_BYTES,
  MAX_AUTOMATION_RESULT_TEXT_UTF8_BYTES,
  MAX_AUTOMATION_SOURCE_RESOLUTION_INPUT_UTF8_BYTES,
  MAX_AUTOMATION_SOURCE_RETRY_AFTER_MS,
  type AutomationConversationAdmitInputV1,
  type AutomationConversationAdmitResultV1,
  type AutomationConversationResultDeliveryV1,
  type AutomationResultDeliveryActionRefV1,
  type AutomationResultDeliveryInputV1,
  type AutomationResultDeliveryResultV1,
  type AutomationResultDeliverySourceV1,
  type AutomationRunResultV1,
} from './automationResultDeliveryV1.js';

// Action catalog consumers import this browser-safe packet directly. This
// legacy Automation module preserves the same runtime schema identities for
// its existing server, persistence, and HTTP consumers.
export {
  AUTOMATION_CONVERSATION_ACTION_IDS_V1,
  AUTOMATION_EVENT_ACTION_IDS_V1,
  AutomationConversationActionIdV1Schema,
  AutomationConversationActionInputSchemasV1,
  AutomationConversationActionOutputSchemasV1,
  AutomationConversationTargetVerifyInputV1Schema,
  AutomationConversationTargetVerifyResultV1Schema,
  AutomationConversationTargetsListInputV1Schema,
  AutomationConversationTargetsListItemV1Schema,
  AutomationConversationTargetsListResultV1Schema,
  AutomationEventActionIdV1Schema,
  AutomationEventActionInputSchemasV1,
  AutomationEventActionOutputSchemasV1,
  AutomationEventAdmitInputV1Schema,
  AutomationEventAdmitDefinitionSelectorV1Schema,
  AutomationEventAdmitContinuationV1Schema,
  AutomationEventAdmitHttpInputV1Schema,
  AutomationEventAdmitItemResultV1Schema,
  AutomationEventAdmitHttpResultV1Schema,
  AutomationEventAdmitResultV1Schema,
  AutomationEventFilterV1Schema,
  AutomationEventSourceCatalogScopeV1Schema,
  AutomationEventSourceCatalogStatusStateV1Schema,
  AutomationEventSourceDefinitionV1Schema,
  AutomationEventSourceObservationTransportV1Schema,
  AutomationEventSourcesListInputV1Schema,
  AutomationEventSourcesListResultV1Schema,
  AutomationEventSourcesListTransportV1Schema,
  AutomationEventSourceStatusCodeV1Schema,
  AutomationEventSourceStatusReportResultV1Schema,
  AutomationEventSourceStatusReportV1Schema,
  AutomationEventSourceStatusStateV1Schema,
  AutomationJsonPointerV1Schema,
  MAX_AUTOMATION_EVENT_FILTER_CLAUSES,
  MAX_AUTOMATION_EVENT_FILTER_IN_VALUES,
  MAX_AUTOMATION_EVENT_FILTER_VALUE_CODE_POINTS,
  MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_ACTION,
  MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL,
  MAX_ENABLED_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_ACCOUNT,
  MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE,
} from './automationActionSpecsV1.js';
export type {
  AutomationConversationActionIdV1,
  AutomationConversationTargetVerifyInputV1,
  AutomationConversationTargetVerifyResultV1,
  AutomationConversationTargetsListInputV1,
  AutomationConversationTargetsListItemV1,
  AutomationConversationTargetsListResultV1,
  AutomationEventActionIdV1,
  AutomationEventAdmitDefinitionSelectorV1,
  AutomationEventAdmitContinuationV1,
  AutomationEventAdmitHttpInputV1,
  AutomationEventAdmitInputV1,
  AutomationEventAdmitItemResultV1,
  AutomationEventAdmitHttpResultV1,
  AutomationEventAdmitResultV1,
  AutomationEventFilterClauseV1,
  AutomationEventFilterV1,
  AutomationEventSourceCatalogScopeV1,
  AutomationEventSourceCatalogStatusStateV1,
  AutomationEventSourceDefinitionV1,
  AutomationEventSourceObservationTransportV1,
  AutomationEventSourcesListInputV1,
  AutomationEventSourcesListResultV1,
  AutomationEventSourcesListTransportV1,
  AutomationEventSourceStatusCodeV1,
  AutomationEventSourceStatusReportV1,
  AutomationEventSourceStatusStateV1,
  AutomationJsonPointerV1,
  AutomationJsonScalarV1,
} from './automationActionSpecsV1.js';

export {
  AutomationAccountCurrentnessWitnessV1Schema,
  projectAutomationAccountCurrentnessWitnessV1,
  sameAutomationAccountContentIdentityV1,
  sameAutomationAccountCurrentnessWitnessV1,
} from './automationAccountCurrentnessV1.js';
export type { AutomationAccountCurrentnessWitnessV1 } from './automationAccountCurrentnessV1.js';

export {
  AutomationObservationTransportKindV1Schema,
  AutomationQualifiedPluginContributionRefV1Schema,
  PluginEventAutomationDeclarationV1Schema,
} from './automationEventDeclarationV1.js';
export type {
  AutomationObservationTransportKindV1,
  AutomationQualifiedPluginContributionRefV1,
  PluginEventAutomationDeclarationV1,
} from './automationEventDeclarationV1.js';

export {
  AutomationEventPayloadV1Schema,
  AutomationEventSourceConfigV1Schema,
  AutomationEventSourceDisplayLabelV1Schema,
  AutomationEventSourceInstanceIdV1Schema,
  MAX_AUTOMATION_EVENT_PAYLOAD_UTF8_BYTES,
  MAX_AUTOMATION_REPLY_CONTEXT_UTF8_BYTES,
  MAX_AUTOMATION_SOURCE_CONFIG_UTF8_BYTES,
  MAX_AUTOMATION_SOURCE_DISPLAY_LABEL_CODE_POINTS,
  MAX_AUTOMATION_SOURCE_OR_OCCURRENCE_ID_UTF8_BYTES,
} from './automationEventJsonBoundsV1.js';
export {
  PluginEventAutomationSetupResultV1Schema,
} from './automationEventSetupResultV1.js';
export type {
  PluginEventAutomationSetupResultV1,
} from './automationEventSetupResultV1.js';
export {
  PluginEventAutomationHistoryGapResetActionInputV1Schema,
  PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
  PluginEventAutomationHistoryGapResetActionResultV1Schema,
  PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
} from './automationEventHistoryGapResetActionV1.js';
export type {
  PluginEventAutomationHistoryGapResetActionInputV1,
  PluginEventAutomationHistoryGapResetActionResultV1,
} from './automationEventHistoryGapResetActionV1.js';
export {
  AutomationConversationAdmitInputV1Schema,
  AutomationConversationAdmitResultV1Schema,
  AutomationConversationResultDeliveryV1Schema,
  AutomationResultDeliveryActionRefV1Schema,
  AutomationResultDeliveryInputV1JsonSchema,
  AutomationResultDeliveryInputV1Schema,
  AutomationResultDeliveryResultV1JsonSchema,
  AutomationResultDeliveryResultV1Schema,
  AutomationResultDeliverySourceV1JsonSchema,
  AutomationResultDeliverySourceV1Schema,
  AutomationRunResultV1JsonSchema,
  AutomationRunResultV1Schema,
  isAutomationConversationResultDeliveryOwnedByCallerV1,
  MAX_AUTOMATION_CONVERSATION_ADMIT_TEXT_UTF8_BYTES,
  MAX_AUTOMATION_RESULT_TEXT_UTF8_BYTES,
  MAX_AUTOMATION_SOURCE_RESOLUTION_INPUT_UTF8_BYTES,
  MAX_AUTOMATION_SOURCE_RETRY_AFTER_MS,
};
export type {
  AutomationConversationAdmitInputV1,
  AutomationConversationAdmitResultV1,
  AutomationConversationResultDeliveryV1,
  AutomationResultDeliveryActionRefV1,
  AutomationResultDeliveryInputV1,
  AutomationResultDeliveryResultV1,
  AutomationResultDeliverySourceV1,
  AutomationRunResultV1,
};

export const MAX_AUTOMATION_PROVIDER_CHECKPOINT_UTF8_BYTES = 64 * 1024;
export const MAX_AUTOMATION_OBSERVATIONS_PER_POLL = 100;
/**
 * Every private Event-admission body has this canonical UTF-8 transport ceiling,
 * regardless of its Account encryption mode. E3 partitions the public Action
 * aggregate before E2 signs and sends each complete private request.
 */
export const MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES = 16 * 1024 * 1024;
export const MAX_NON_TERMINAL_AUTOMATIC_RUNS_PER_ACCOUNT = 10_000;

const UTF8_ENCODER = new TextEncoder();

export function readAutomationEventAdmitHttpRequestCanonicalUtf8ByteLengthV1(
  value: unknown,
): number {
  return UTF8_ENCODER.encode(createCanonicalJsonSigningInput(value)).byteLength;
}

const PRIVATE_STORED_DEFINITION_SCOPE_SCHEMA = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export type AutomationEventFilterPayloadSchemaValidationIssueV1 =
  | Readonly<{ code: 'filter_invalid' }>
  | Readonly<{ code: 'payload_schema_missing' }>
  | Readonly<{ code: 'payload_schema_invalid' }>
  | Readonly<{
    code: 'field_not_declared';
    clauseIndex: number;
    field: AutomationJsonPointerV1;
  }>
  | Readonly<{
    code: 'field_not_scalar';
    clauseIndex: number;
    field: AutomationJsonPointerV1;
  }>
  | Readonly<{
    code: 'value_incompatible';
    clauseIndex: number;
    field: AutomationJsonPointerV1;
    valueIndex: number;
  }>;

export type AutomationEventFilterPayloadSchemaValidationResultV1 =
  | Readonly<{ kind: 'valid' }>
  | Readonly<{
    kind: 'invalid';
    issue: AutomationEventFilterPayloadSchemaValidationIssueV1;
  }>;

type AutomationEventFilterScalarAtomV1 =
  | 'null'
  | 'boolean'
  | 'integer'
  | 'nonIntegerNumber'
  | 'string';

type AutomationEventFilterSchemaIntersectionV1 = readonly PluginJsonSchemaV2[];

type AutomationEventFilterScalarLeafResolutionV1 =
  | Readonly<{ kind: 'declared'; validators: readonly PluginJsonSchemaValidator[] }>
  | Readonly<{ kind: 'notDeclared' }>
  | Readonly<{ kind: 'notScalar' }>;

const AUTOMATION_EVENT_FILTER_SCALAR_ATOMS_V1 = new Set<AutomationEventFilterScalarAtomV1>([
  'null',
  'boolean',
  'integer',
  'nonIntegerNumber',
  'string',
]);

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function withoutAllOf(schema: PluginJsonSchemaV2): PluginJsonSchemaV2 {
  const { allOf: _allOf, ...remaining } = schema;
  return remaining;
}

function withoutAnyOf(schema: PluginJsonSchemaV2): PluginJsonSchemaV2 {
  const { anyOf: _anyOf, ...remaining } = schema;
  return remaining;
}

function withoutOneOf(schema: PluginJsonSchemaV2): PluginJsonSchemaV2 {
  const { oneOf: _oneOf, ...remaining } = schema;
  return remaining;
}

/**
 * Resolves one static schema alternative at a time. Dynamic object keys never
 * become filter paths: Event filters must name one declared payload leaf.
 */
function expandAutomationEventFilterSchemaIntersectionV1(
  intersection: AutomationEventFilterSchemaIntersectionV1,
): readonly AutomationEventFilterSchemaIntersectionV1[] {
  for (let index = 0; index < intersection.length; index += 1) {
    const schema = intersection[index]!;
    if (schema.allOf && schema.allOf.length > 0) {
      return expandAutomationEventFilterSchemaIntersectionV1([
        ...intersection.slice(0, index),
        withoutAllOf(schema),
        ...schema.allOf,
        ...intersection.slice(index + 1),
      ]);
    }
    if (schema.anyOf && schema.anyOf.length > 0) {
      return schema.anyOf.flatMap((branch) => (
        expandAutomationEventFilterSchemaIntersectionV1([
          ...intersection.slice(0, index),
          withoutAnyOf(schema),
          branch,
          ...intersection.slice(index + 1),
        ])
      ));
    }
    if (schema.oneOf && schema.oneOf.length > 0) {
      return schema.oneOf.flatMap((branch) => (
        expandAutomationEventFilterSchemaIntersectionV1([
          ...intersection.slice(0, index),
          withoutOneOf(schema),
          branch,
          ...intersection.slice(index + 1),
        ])
      ));
    }
  }
  return [intersection];
}

function isAutomationEventFilterJsonObject(value: PluginJsonValueV2): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaMayContainAutomationEventFilterObject(schema: PluginJsonSchemaV2): boolean {
  if (schema.type !== undefined) return schema.type === 'object';
  if (hasOwn(schema, 'const')) return isAutomationEventFilterJsonObject(schema.const!);
  if (schema.enum) return schema.enum.some(isAutomationEventFilterJsonObject);
  return true;
}

function decodeAutomationEventFilterPointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveAutomationEventFilterObjectSegmentV1(
  intersection: AutomationEventFilterSchemaIntersectionV1,
  segment: string,
): readonly AutomationEventFilterSchemaIntersectionV1[] {
  const children: PluginJsonSchemaV2[] = [];
  let declared = false;
  for (const schema of intersection) {
    if (!schemaMayContainAutomationEventFilterObject(schema)) return [];
    const property = schema.properties && hasOwn(schema.properties, segment)
      ? schema.properties[segment]
      : undefined;
    if (property !== undefined) {
      children.push(property);
      declared = true;
      continue;
    }
    if (schema.additionalProperties === false) return [];
  }
  return declared
    ? expandAutomationEventFilterSchemaIntersectionV1(children)
    : [];
}

function resolveAutomationEventFilterSchemaSegmentV1(
  intersection: AutomationEventFilterSchemaIntersectionV1,
  segment: string,
): readonly AutomationEventFilterSchemaIntersectionV1[] {
  const expanded = expandAutomationEventFilterSchemaIntersectionV1(intersection);
  const resolved: AutomationEventFilterSchemaIntersectionV1[] = [];
  for (const alternative of expanded) {
    const objectResult = resolveAutomationEventFilterObjectSegmentV1(alternative, segment);
    resolved.push(...objectResult);
  }
  return resolved;
}

function scalarAtomsForAutomationEventFilterValue(
  value: PluginJsonValueV2,
): ReadonlySet<AutomationEventFilterScalarAtomV1> {
  if (value === null) return new Set(['null']);
  if (typeof value === 'boolean') return new Set(['boolean']);
  if (typeof value === 'string') return new Set(['string']);
  if (typeof value === 'number') {
    return new Set([Number.isInteger(value) ? 'integer' : 'nonIntegerNumber']);
  }
  return new Set();
}

function scalarAtomsForAutomationEventFilterSchema(
  schema: PluginJsonSchemaV2,
): Readonly<{
  scalarAtoms: ReadonlySet<AutomationEventFilterScalarAtomV1>;
  permitsNonScalar: boolean;
  declaresScalar: boolean;
}> {
  if (schema.type !== undefined) {
    switch (schema.type) {
      case 'null':
        return { scalarAtoms: new Set(['null']), permitsNonScalar: false, declaresScalar: true };
      case 'boolean':
        return { scalarAtoms: new Set(['boolean']), permitsNonScalar: false, declaresScalar: true };
      case 'integer':
        return { scalarAtoms: new Set(['integer']), permitsNonScalar: false, declaresScalar: true };
      case 'number':
        return {
          scalarAtoms: new Set(['integer', 'nonIntegerNumber']),
          permitsNonScalar: false,
          declaresScalar: true,
        };
      case 'string':
        return { scalarAtoms: new Set(['string']), permitsNonScalar: false, declaresScalar: true };
      case 'array':
      case 'object':
        return { scalarAtoms: new Set(), permitsNonScalar: true, declaresScalar: true };
    }
  }
  if (hasOwn(schema, 'const')) {
    const scalarAtoms = scalarAtomsForAutomationEventFilterValue(schema.const!);
    return {
      scalarAtoms,
      permitsNonScalar: scalarAtoms.size === 0,
      declaresScalar: true,
    };
  }
  if (schema.enum) {
    const scalarAtoms = new Set<AutomationEventFilterScalarAtomV1>();
    let permitsNonScalar = false;
    for (const value of schema.enum) {
      const atoms = scalarAtomsForAutomationEventFilterValue(value);
      if (atoms.size === 0) {
        permitsNonScalar = true;
        continue;
      }
      for (const atom of atoms) scalarAtoms.add(atom);
    }
    return { scalarAtoms, permitsNonScalar, declaresScalar: true };
  }
  return {
    scalarAtoms: AUTOMATION_EVENT_FILTER_SCALAR_ATOMS_V1,
    permitsNonScalar: true,
    declaresScalar: false,
  };
}

function intersectAutomationEventFilterScalarAtoms(
  left: ReadonlySet<AutomationEventFilterScalarAtomV1>,
  right: ReadonlySet<AutomationEventFilterScalarAtomV1>,
): Set<AutomationEventFilterScalarAtomV1> {
  return new Set([...left].filter((atom) => right.has(atom)));
}

function compileAutomationEventFilterScalarLeafV1(
  intersection: AutomationEventFilterSchemaIntersectionV1,
): PluginJsonSchemaValidator | null {
  let scalarAtoms = new Set(AUTOMATION_EVENT_FILTER_SCALAR_ATOMS_V1);
  let permitsNonScalar = true;
  let declaresScalar = false;
  for (const schema of intersection) {
    const domain = scalarAtomsForAutomationEventFilterSchema(schema);
    scalarAtoms = intersectAutomationEventFilterScalarAtoms(scalarAtoms, domain.scalarAtoms);
    permitsNonScalar = permitsNonScalar && domain.permitsNonScalar;
    declaresScalar = declaresScalar || domain.declaresScalar;
  }
  if (!declaresScalar || permitsNonScalar || scalarAtoms.size === 0) return null;
  try {
    return compilePluginJsonSchema(
      intersection.length === 1 ? intersection[0]! : { allOf: [...intersection] },
    );
  } catch {
    return null;
  }
}

function resolveAutomationEventFilterScalarLeafV1(
  payloadSchema: PluginJsonSchemaV2,
  pointer: AutomationJsonPointerV1,
): AutomationEventFilterScalarLeafResolutionV1 {
  let candidates: readonly AutomationEventFilterSchemaIntersectionV1[] = [
    [payloadSchema],
  ];
  for (const encodedSegment of pointer.slice(1).split('/')) {
    const segment = decodeAutomationEventFilterPointerSegment(encodedSegment);
    candidates = candidates.flatMap((candidate) => (
      resolveAutomationEventFilterSchemaSegmentV1(candidate, segment)
    ));
    if (candidates.length === 0) return { kind: 'notDeclared' };
  }
  const validators = candidates.flatMap((candidate) => {
    const validator = compileAutomationEventFilterScalarLeafV1(candidate);
    return validator ? [validator] : [];
  });
  return validators.length > 0
    ? { kind: 'declared', validators }
    : { kind: 'notScalar' };
}

/**
 * The schema-owned Event-filter authoring contract. It accepts only declared
 * scalar leaves of the exact current Event payload schema and requires every
 * operand to satisfy that leaf's JSON Schema without coercion.
 */
export function validateAutomationEventFilterAgainstPayloadSchemaV1(params: Readonly<{
  filter: AutomationEventFilterV1 | null;
  payloadSchema: PluginJsonSchemaV2 | null | undefined;
}>): AutomationEventFilterPayloadSchemaValidationResultV1 {
  if (params.payloadSchema === null || params.payloadSchema === undefined) {
    return { kind: 'invalid', issue: { code: 'payload_schema_missing' } };
  }
  let payloadSchema: PluginJsonSchemaV2;
  try {
    payloadSchema = normalizePluginJsonSchema(params.payloadSchema);
    compilePluginJsonSchema(payloadSchema);
  } catch {
    return { kind: 'invalid', issue: { code: 'payload_schema_invalid' } };
  }
  if (params.filter === null) return { kind: 'valid' };
  const parsedFilter = AutomationEventFilterV1Schema.safeParse(params.filter);
  if (!parsedFilter.success) {
    return { kind: 'invalid', issue: { code: 'filter_invalid' } };
  }
  for (const [clauseIndex, clause] of parsedFilter.data.all.entries()) {
    const leaf = resolveAutomationEventFilterScalarLeafV1(payloadSchema, clause.field);
    if (leaf.kind === 'notDeclared') {
      return {
        kind: 'invalid',
        issue: { code: 'field_not_declared', clauseIndex, field: clause.field },
      };
    }
    if (leaf.kind === 'notScalar') {
      return {
        kind: 'invalid',
        issue: { code: 'field_not_scalar', clauseIndex, field: clause.field },
      };
    }
    const values = clause.op === 'eq' ? [clause.value] : clause.values;
    for (const [valueIndex, value] of values.entries()) {
      if (!leaf.validators.some((validator) => isValidPluginJsonSchemaValue(validator, value))) {
        return {
          kind: 'invalid',
          issue: { code: 'value_incompatible', clauseIndex, field: clause.field, valueIndex },
        };
      }
    }
  }
  return { kind: 'valid' };
}

/**
 * The private, mode-correct source facts retained by an Event Automation
 * definition. The public selector and Event identity remain in Automation
 * columns; this payload owns only provider-private source/filter facts that
 * admission must evaluate before it creates a Run.
 */
export const AutomationEventTriggerDefinitionStoredPayloadV1Schema = z.object({
  v: z.literal(1),
  sourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
  webhookRoutingSourceInstanceId: AutomationEventSourceInstanceIdV1Schema.optional(),
  sourceConfig: asProtocolZod(AutomationEventSourceConfigV1Schema),
  displayLabel: AutomationEventSourceDisplayLabelV1Schema,
  filter: AutomationEventFilterV1Schema.nullable(),
  maximumObservationAgeMs: NONNEGATIVE_SAFE_INTEGER_SCHEMA.nullable(),
}).strict();
export type AutomationEventTriggerDefinitionStoredPayloadV1 = z.infer<
  typeof AutomationEventTriggerDefinitionStoredPayloadV1Schema
>;

function resolveJsonPointer(value: PluginJsonValueV2, pointer: AutomationJsonPointerV1): unknown {
  let current: unknown = value;
  for (const encodedSegment of pointer.slice(1).split('/')) {
    const segment = encodedSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return undefined;
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== 'object'
      || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function sameAutomationJsonScalar(left: unknown, right: AutomationJsonScalarV1): boolean {
  if (left === null || typeof left === 'boolean' || typeof left === 'string') return left === right;
  return typeof left === 'number' && typeof right === 'number' && Number.isFinite(left) && left === right;
}

/** A total, coercion-free runtime evaluator; authoring validates schema leaf types separately. */
export function evaluateAutomationEventFilterV1(
  filter: AutomationEventFilterV1 | null,
  payload: unknown,
): boolean {
  if (filter === null) return true;
  const parsedFilter = AutomationEventFilterV1Schema.safeParse(filter);
  const parsedPayload = PluginJsonValueV2Schema.safeParse(payload);
  if (!parsedFilter.success || !parsedPayload.success) return false;
  return parsedFilter.data.all.every((clause) => {
    const candidate = resolveJsonPointer(parsedPayload.data, clause.field);
    if (clause.op === 'eq') return sameAutomationJsonScalar(candidate, clause.value);
    return clause.values.some((value) => sameAutomationJsonScalar(candidate, value));
  });
}

/**
 * The sole Event observation freshness rule for every admission owner (server
 * and CLI alike). `maximumObservationAgeMs` bounds how *stale* an occurrence
 * may be, so it is measured only in the forward direction: `occurredAt` is
 * minted by the observed source's clock, and a source clock that leads this
 * host's receipt time makes the occurrence newer than local time rather than
 * older. Skipping such an occurrence as `outsideFreshness` would silently drop
 * a genuinely fresh Event, and nothing downstream is pinned to `occurredAt`, so
 * the lead stays admissible. A null bound disables the freshness gate.
 */
export function isAutomationEventObservationFreshV1(input: Readonly<{
  occurredAt: number;
  observationReceivedAt: number;
  maximumObservationAgeMs: number | null;
}>): boolean {
  return input.maximumObservationAgeMs === null
    || input.observationReceivedAt - input.occurredAt <= input.maximumObservationAgeMs;
}

export const AutomationEventTriggerObservationTransportV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('checkpointedPull'),
    watcherMaterializationRef: PluginMachineMaterializationRefV1Schema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal('durablePush'),
    webhookEndpointId: PluginWebhookEndpointIdV1Schema,
    observationStartsAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  }).strict(),
]);
export type AutomationEventTriggerObservationTransportV1 = z.infer<
  typeof AutomationEventTriggerObservationTransportV1Schema
>;


/**
 * A bounded, canonical strict Run recipe serialized by the Protocol recipe
 * owner. The Event transport deliberately bounds only its opaque framing;
 * callers that consume it must use the recipe owner's parser rather than
 * introducing a second JSON reader here.
 */
export const AutomationEventStoredExecutionRecipeV1Schema = z.string().min(1).superRefine((value, context) => {
  if (UTF8_ENCODER.encode(value).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event execution recipe exceeds its UTF-8 byte limit' });
  }
});

/**
 * Existing immutable release evidence for the Event declaration from which E3
 * compiled its payload validator. This is an opaque release witness, never a
 * schema or semantic Event payload projection.
 */
export const AutomationEventDeclarationReleaseV1Schema = z.object({
  release: PluginReleaseRefV1Schema,
  archiveDigestSha256: PluginUiArtifactDigestV1Schema,
}).strict();
export type AutomationEventDeclarationReleaseV1 = z.infer<
  typeof AutomationEventDeclarationReleaseV1Schema
>;

export function isSameAutomationEventDeclarationReleaseV1(
  left: AutomationEventDeclarationReleaseV1,
  right: AutomationEventDeclarationReleaseV1,
): boolean {
  return left.release.pluginId === right.release.pluginId
    && left.release.version === right.release.version
    && left.archiveDigestSha256 === right.archiveDigestSha256;
}

/**
 * Internal server-to-host projection used only by the Event-source owner.
 * It carries the existing mode-tagged stored envelope to one authenticated,
 * exact materialization; it is not a public Action result or SDK surface.
 */
export const AutomationEventStoredDefinitionProjectionV1Schema = z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  templateVersion: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  sourceContractVersion: POSITIVE_SAFE_INTEGER_SCHEMA,
  observationTransport: AutomationEventSourceObservationTransportV1Schema,
  storedDefinitionEnvelope: AutomationStoredContentEnvelopeV1Schema,
  executionRecipe: AutomationEventStoredExecutionRecipeV1Schema,
  payloadSchema: PluginJsonSchemaV2Schema,
}).strict();
export type AutomationEventStoredDefinitionProjectionV1 = z.infer<
  typeof AutomationEventStoredDefinitionProjectionV1Schema
>;

/**
 * Internal response for one private stored-definition read. Revision and cursor
 * semantics mirror the public source list, while plaintext projection remains
 * host-owned and happens only after canonical Account crypto validation.
 */
export const AutomationEventStoredDefinitionsReadResultV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('page'),
    revision: UNSIGNED_DECIMAL_BIGINT_SCHEMA,
    eventDeclarationRelease: AutomationEventDeclarationReleaseV1Schema,
    // Opaque host-private scope evidence. The public source-list Action never
    // exposes it; the adopted-definition owner uses it to invalidate a local
    // cursor when the generic endpoint target changes without a catalog edit.
    scope: PRIVATE_STORED_DEFINITION_SCOPE_SCHEMA.optional(),
    definitions: z.array(AutomationEventStoredDefinitionProjectionV1Schema)
      .max(MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE),
    nextCursor: OPAQUE_CURSOR_SCHEMA.nullable(),
  }).strict(),
  z.object({
    kind: z.literal('unchanged'),
    revision: UNSIGNED_DECIMAL_BIGINT_SCHEMA,
    eventDeclarationRelease: AutomationEventDeclarationReleaseV1Schema,
    scope: PRIVATE_STORED_DEFINITION_SCOPE_SCHEMA.optional(),
  }).strict(),
  z.object({ kind: z.literal('cursorStale'), currentRevision: UNSIGNED_DECIMAL_BIGINT_SCHEMA }).strict(),
]).superRefine((value, context) => {
  if (value.kind !== 'page') return;
  value.definitions.forEach((definition, index) => {
    if (definition.eventRef.pluginId !== value.eventDeclarationRelease.release.pluginId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['definitions', index, 'eventRef', 'pluginId'],
        message: 'Every stored Event definition must belong to its declaration release plugin.',
      });
    }
  });
});
export type AutomationEventStoredDefinitionsReadResultV1 = z.infer<
  typeof AutomationEventStoredDefinitionsReadResultV1Schema
>;

const AutomationEventAdmitEncryptedEnvelopeV1Schema = ENCRYPTED_STORED_CONTENT_SCHEMA.superRefine(
  (value, context) => {
    addAutomationStoredEnvelopeUtf8LimitIssue(
      value,
      context,
      'Encrypted Event admission envelope exceeds its UTF-8 byte limit',
    );
    if (readCanonicalPaddedBase64DecodedLength(value.c) === null || !isAccountScopedBlobCiphertextForKind({
      kind: 'automation_trigger_evidence',
      ciphertext: value.c,
    })) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['c'],
        message: 'Encrypted Event admission evidence must use the trigger-evidence cipher kind',
      });
    }
  },
);

export const AutomationEventAdmitEncryptedDefinitionOutcomeV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('matched'),
    executionRecipe: AutomationEventStoredExecutionRecipeV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('skipped'),
    reason: z.enum([
      'filtered',
      'beforeObservationStart',
      'outsideFreshness',
      'definitionRetired',
      'occurrenceRejected',
    ]),
  }).strict(),
]);

export const AutomationEventAdmitEncryptedDefinitionEvidenceV1Schema = z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  templateVersion: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  sourceContractVersion: POSITIVE_SAFE_INTEGER_SCHEMA,
  observationTransport: AutomationObservationTransportKindV1Schema,
  occurrenceKey: AutomationOccurrenceKeyV1Schema,
  occurredAt: AutomationOriginOccurredAtV1Schema,
  // The server can classify this fixed envelope kind but never opens the
  // Account-scoped contents.  It is common to both outcome arms so a replay
  // can rejoin before a later filter/currentness decision is considered.
  triggerEvidenceEnvelope: AutomationEventAdmitEncryptedEnvelopeV1Schema,
  occurrenceEvidenceEqualityTag: AutomationOccurrenceEvidenceEqualityTagV1Schema,
  outcome: AutomationEventAdmitEncryptedDefinitionOutcomeV1Schema,
}).strict();
export type AutomationEventAdmitEncryptedDefinitionEvidenceV1 = z.infer<
  typeof AutomationEventAdmitEncryptedDefinitionEvidenceV1Schema
>;

/**
 * Private host evidence constructed by the exact-machine Event owner. Plain
 * admission keeps its semantic input; encrypted admission carries only this
 * sealed, revision-bound outcome package.
 */
export const AutomationEventAdmitPlainHostEvidenceV1Schema = z.object({
    v: z.literal(1),
    t: z.literal('plain'),
    accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
    webhookInvocationReference: PluginWebhookInvocationReferenceV1Schema.optional(),
  }).strict().superRefine((value, context) => {
    if (value.accountCurrentness.mode !== 'plain') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accountCurrentness', 'mode'],
        message: 'Plain Event evidence requires plain Account currentness',
      });
    }
  });

export const AutomationEventAdmitEncryptedHostEvidenceV1Schema = z.object({
    v: z.literal(1),
    t: z.literal('encrypted'),
    accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
    adoptedRevision: UNSIGNED_DECIMAL_BIGINT_SCHEMA,
    eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
    eventDeclarationRelease: AutomationEventDeclarationReleaseV1Schema,
    definitions: z.array(AutomationEventAdmitEncryptedDefinitionEvidenceV1Schema)
      .min(1)
      .max(MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL),
    webhookInvocationReference: PluginWebhookInvocationReferenceV1Schema.optional(),
  }).strict().superRefine((value, context) => {
    if (value.accountCurrentness.mode !== 'e2ee') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accountCurrentness', 'mode'],
        message: 'Encrypted Event evidence requires E2EE Account currentness',
      });
    }
    if (value.eventDeclarationRelease.release.pluginId !== value.eventRef.pluginId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['eventDeclarationRelease', 'release', 'pluginId'],
        message: 'Event declaration release must match the Event plugin.',
      });
    }
  });
export type AutomationEventAdmitPlainHostEvidenceV1 = z.infer<
  typeof AutomationEventAdmitPlainHostEvidenceV1Schema
>;
export type AutomationEventAdmitEncryptedHostEvidenceV1 = z.infer<
  typeof AutomationEventAdmitEncryptedHostEvidenceV1Schema
>;

export const AutomationEventAdmitHostEvidenceV1Schema = z.discriminatedUnion('t', [
  AutomationEventAdmitPlainHostEvidenceV1Schema,
  AutomationEventAdmitEncryptedHostEvidenceV1Schema,
]);
export type AutomationEventAdmitHostEvidenceV1 = z.infer<
  typeof AutomationEventAdmitHostEvidenceV1Schema
>;

/**
 * Immutable correspondence sealed alongside every Conversation Automation
 * handoff payload. The target daemon compares this inner binding with the
 * server-routed claim before it can invoke the target plugin's Action.
 */
export const AutomationReplyHandoffCorrespondenceV1Schema = z.object({
  accountId: asProtocolZod(HostIdentifierV1Schema),
  automationId: asProtocolZod(AutomationIdV1Schema),
  runId: asProtocolZod(HostIdentifierV1Schema),
  handoffId: asProtocolZod(HostIdentifierV1Schema),
}).strict();
export type AutomationReplyHandoffCorrespondenceV1 = z.infer<
  typeof AutomationReplyHandoffCorrespondenceV1Schema
>;

export const AutomationRunResultCorrespondenceV1Schema = z.union([
  AutomationReplyHandoffCorrespondenceV1Schema,
  z.object({
    accountId: asProtocolZod(HostIdentifierV1Schema),
    automationId: asProtocolZod(AutomationIdV1Schema),
    runId: asProtocolZod(HostIdentifierV1Schema),
  }).strict(),
]);
export type AutomationRunResultCorrespondenceV1 = z.infer<
  typeof AutomationRunResultCorrespondenceV1Schema
>;

export const AutomationRunResultStoredPayloadV1Schema = z.object({
  v: z.literal(1),
  correspondence: AutomationRunResultCorrespondenceV1Schema,
  result: AutomationRunResultV1Schema,
}).strict();
export type AutomationRunResultStoredPayloadV1 = z.infer<
  typeof AutomationRunResultStoredPayloadV1Schema
>;

export const AutomationConversationReplyContextStoredPayloadV1Schema = z.object({
  v: z.literal(1),
  correspondence: AutomationReplyHandoffCorrespondenceV1Schema,
  source: AutomationResultDeliverySourceV1Schema,
  opaqueContext: asProtocolZod(AutomationEventReplyContextV1Schema),
}).strict();
export type AutomationConversationReplyContextStoredPayloadV1 = z.infer<
  typeof AutomationConversationReplyContextStoredPayloadV1Schema
>;

export const AutomationRunResultStoredV1Schema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('legacySummaryCiphertext'), c: z.string() }).strict(),
  z.object({ t: z.literal('plain'), v: AutomationRunResultStoredPayloadV1Schema }).strict(),
  ENCRYPTED_STORED_CONTENT_SCHEMA,
]).superRefine((value, context) => {
  if (UTF8_ENCODER.encode(createCanonicalJsonSigningInput(value)).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Stored Automation result exceeds its UTF-8 byte limit' });
  }
});
export type AutomationRunResultStoredV1 = z.infer<typeof AutomationRunResultStoredV1Schema>;

export const AutomationConversationReplyContextStoredV1Schema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: AutomationConversationReplyContextStoredPayloadV1Schema }).strict(),
  ENCRYPTED_STORED_CONTENT_SCHEMA,
]).superRefine((value, context) => {
  if (UTF8_ENCODER.encode(createCanonicalJsonSigningInput(value)).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Stored Conversation reply context exceeds its UTF-8 byte limit' });
  }
});
export type AutomationConversationReplyContextStoredV1 = z.infer<
  typeof AutomationConversationReplyContextStoredV1Schema
>;

export const AutomationRunReplyHandoffStateV1Schema = z.enum([
  'none',
  'awaitingResult',
  'ready',
  'handingOff',
  'accepted',
  'suppressed',
  'blocked',
]);
export type AutomationRunReplyHandoffStateV1 = z.infer<typeof AutomationRunReplyHandoffStateV1Schema>;

/**
 * The private Action outcome is retained for the receipt owner only. The
 * server receives the outer envelope and a coarse settlement projection, never
 * this payload or a provider/Channels detail.
 */
export const AutomationReplyHandoffReceiptPayloadV1Schema = z.object({
  v: z.literal(1),
  correspondence: AutomationReplyHandoffCorrespondenceV1Schema,
  result: AutomationResultDeliveryResultV1Schema,
}).strict();
export type AutomationReplyHandoffReceiptPayloadV1 = z.infer<
  typeof AutomationReplyHandoffReceiptPayloadV1Schema
>;

export const AutomationReplyHandoffReceiptStoredV1Schema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: AutomationReplyHandoffReceiptPayloadV1Schema }).strict(),
  ENCRYPTED_STORED_CONTENT_SCHEMA,
]).superRefine((value, context) => {
  if (UTF8_ENCODER.encode(createCanonicalJsonSigningInput(value)).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Stored Conversation reply receipt exceeds its UTF-8 byte limit' });
  }
});
export type AutomationReplyHandoffReceiptStoredV1 = z.infer<
  typeof AutomationReplyHandoffReceiptStoredV1Schema
>;

/**
 * The only server-readable classification of a reply-handoff payload. It
 * validates the bounded persisted shape and its Account-mode tag, but never
 * opens ciphertext or exposes an inner payload to the server.
 */
export const AutomationReplyHandoffStoredEnvelopeContentV1Schema = z.enum([
  'result',
  'replyContext',
  'receipt',
]);
export type AutomationReplyHandoffStoredEnvelopeContentV1 = z.infer<
  typeof AutomationReplyHandoffStoredEnvelopeContentV1Schema
>;

export type AutomationReplyHandoffStoredEnvelopeOuterValidationV1 =
  | Readonly<{
      kind: 'available';
      envelope:
        | AutomationRunResultStoredV1
        | AutomationConversationReplyContextStoredV1
        | AutomationReplyHandoffReceiptStoredV1;
    }>
  | Readonly<{ kind: 'modeMismatch' }>
  | Readonly<{ kind: 'legacyUnsupported' }>
  | Readonly<{ kind: 'contentInvalid' }>;

/**
 * Validate persisted reply-handoff content at the server/daemon boundary
 * without decrypting it. Historical result ciphertext is deliberately
 * classified as read-only and never becomes dispatchable correspondence.
 */
export function validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1(params: Readonly<{
  content: AutomationReplyHandoffStoredEnvelopeContentV1;
  mode: 'plain' | 'e2ee';
  envelope: unknown;
}>): AutomationReplyHandoffStoredEnvelopeOuterValidationV1 {
  let parsed:
    | ReturnType<typeof AutomationRunResultStoredV1Schema.safeParse>
    | ReturnType<typeof AutomationConversationReplyContextStoredV1Schema.safeParse>
    | ReturnType<typeof AutomationReplyHandoffReceiptStoredV1Schema.safeParse>;
  switch (params.content) {
    case 'result':
      parsed = AutomationRunResultStoredV1Schema.safeParse(params.envelope);
      break;
    case 'replyContext':
      parsed = AutomationConversationReplyContextStoredV1Schema.safeParse(params.envelope);
      break;
    case 'receipt':
      parsed = AutomationReplyHandoffReceiptStoredV1Schema.safeParse(params.envelope);
      break;
  }
  if (!parsed.success) return { kind: 'contentInvalid' };

  const envelope = parsed.data;
  if (envelope.t === 'legacySummaryCiphertext') {
    return params.content === 'result'
      ? { kind: 'legacyUnsupported' }
      : { kind: 'contentInvalid' };
  }
  if (
    (params.mode === 'plain' && envelope.t !== 'plain')
    || (params.mode === 'e2ee' && envelope.t !== 'encrypted')
  ) {
    return { kind: 'modeMismatch' };
  }
  return { kind: 'available', envelope };
}

export type AutomationReplyHandoffStoredContentOpenFailureV1 =
  | Readonly<{ kind: 'modeMismatch' }>
  | Readonly<{ kind: 'materialUnavailable' }>
  | Readonly<{ kind: 'legacyUnsupported' }>
  | Readonly<{ kind: 'contentInvalid' }>;

/**
 * Host-internal, server-to-exact-daemon command. It is deliberately not an
 * Action, plugin API, or public RPC family: the Socket.IO server is its only
 * sender and the receiving daemon verifies every frozen correspondence fact.
 */
export const AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1 =
  'daemon.automations.replyHandoff.dispatch' as const;

export const AutomationReplyHandoffTargetV1Schema = z.object({
  accountId: asProtocolZod(HostIdentifierV1Schema),
  machineId: asProtocolZod(HostIdentifierV1Schema),
  machineInstallationId: asProtocolZod(HostIdentifierV1Schema),
  materializationId: PluginMachineMaterializationIdV1Schema,
  actionRef: AutomationResultDeliveryActionRefV1Schema,
}).strict();
export type AutomationReplyHandoffTargetV1 = z.infer<
  typeof AutomationReplyHandoffTargetV1Schema
>;

const AutomationLegacyRunResultEnvelopeV1Schema = z.object({
  t: z.literal('legacySummaryCiphertext'),
  c: z.string(),
}).strict();

/**
 * A transport envelope intentionally admits only a bounded outer tagged shape.
 * It keeps the server from becoming a plaintext reader while letting the daemon
 * classify historical result content as terminally ineligible for reply
 * delivery.
 */
export const AutomationReplyHandoffResultEnvelopeTransportV1Schema = z.union([
  AutomationLegacyRunResultEnvelopeV1Schema,
  AutomationStoredContentEnvelopeV1Schema,
]).superRefine((value, context) => {
  if (UTF8_ENCODER.encode(createCanonicalJsonSigningInput(value)).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Automation reply-handoff result envelope exceeds its UTF-8 byte limit' });
  }
});
export type AutomationReplyHandoffResultEnvelopeTransportV1 = z.infer<
  typeof AutomationReplyHandoffResultEnvelopeTransportV1Schema
>;

/**
 * Server-routed claim facts. The envelope values deliberately use only the
 * bounded outer tagged shape: the server validates/routs bytes but does not
 * inspect plaintext payloads or decrypt ciphertext.
 */
export const AutomationReplyHandoffClaimV1Schema = z.object({
  handoffId: asProtocolZod(HostIdentifierV1Schema),
  runId: asProtocolZod(HostIdentifierV1Schema),
  automationId: asProtocolZod(AutomationIdV1Schema),
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
  resultEnvelope: AutomationReplyHandoffResultEnvelopeTransportV1Schema,
  replyContextEnvelope: AutomationStoredContentEnvelopeV1Schema,
}).strict();
export type AutomationReplyHandoffClaimV1 = z.infer<
  typeof AutomationReplyHandoffClaimV1Schema
>;

export const AutomationReplyHandoffDispatchRequestV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('automation.replyHandoff.dispatch'),
  target: AutomationReplyHandoffTargetV1Schema,
  handoff: AutomationReplyHandoffClaimV1Schema,
}).strict();
export type AutomationReplyHandoffDispatchRequestV1 = z.infer<
  typeof AutomationReplyHandoffDispatchRequestV1Schema
>;

/**
 * The only settlement detail the ciphertext-blind server can act on. Action
 * custody ids, suppression reasons, block codes, and provider detail stay in
 * the sealed receipt envelope owned by the target daemon/plugin consumer.
 */
export const AutomationReplyHandoffSettlementV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted') }).strict(),
  z.object({ kind: z.literal('suppressed') }).strict(),
  /** Claimed Account or Run authority moved before the daemon could act. */
  z.object({ kind: z.literal('staleClaim') }).strict(),
  z.object({
    kind: z.literal('retry'),
    retryAfterMs: NONNEGATIVE_SAFE_INTEGER_SCHEMA.max(MAX_AUTOMATION_SOURCE_RETRY_AFTER_MS),
  }).strict(),
  z.object({ kind: z.literal('blocked') }).strict(),
]);
export type AutomationReplyHandoffSettlementV1 = z.infer<
  typeof AutomationReplyHandoffSettlementV1Schema
>;

export const AutomationReplyHandoffDispatchResultV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('settled'),
    settlement: AutomationReplyHandoffSettlementV1Schema,
    accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
    /** Opaque to the server; validates only bounded mode-tagged outer shape. */
    receiptEnvelope: AutomationStoredContentEnvelopeV1Schema.optional(),
  }).strict().superRefine((value, context) => {
    if (
      value.receiptEnvelope !== undefined
      && (
        (value.accountCurrentness.mode === 'plain' && value.receiptEnvelope.t !== 'plain')
        || (value.accountCurrentness.mode === 'e2ee' && value.receiptEnvelope.t !== 'encrypted')
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receiptEnvelope', 't'],
        message: 'Receipt envelope tag must match Account currentness mode',
      });
    }
    if (
      (value.settlement.kind === 'accepted' || value.settlement.kind === 'suppressed')
      && value.receiptEnvelope === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receiptEnvelope'],
        message: 'Accepted and suppressed handoffs require their opaque receipt envelope',
      });
    }
  }),
  z.object({
    kind: z.literal('unavailable'),
    code: z.enum([
      'invalidRequest',
      'targetMismatch',
      'targetUnavailable',
      'actionUnavailable',
      'cancelled',
      'contractInvalid',
    ]),
  }).strict(),
]);
export type AutomationReplyHandoffDispatchResultV1 = z.infer<
  typeof AutomationReplyHandoffDispatchResultV1Schema
>;

const AUTOMATION_DURABLE_PUSH_SCOPE_PREFIX = 'durablePush:';
const AutomationEventSourceCatalogScopeKeyV1Schema = z.string().superRefine((value, context) => {
  if (value === 'checkpointedPull') return;
  if (!value.startsWith(AUTOMATION_DURABLE_PUSH_SCOPE_PREFIX)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown Automation source catalog scope' });
    return;
  }
  const endpointId = value.slice(AUTOMATION_DURABLE_PUSH_SCOPE_PREFIX.length);
  if (!PluginWebhookEndpointIdV1Schema.safeParse(endpointId).success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Durable-push catalog scopes require one canonical webhook endpoint ID',
    });
  }
});

export const AutomationEventSourceStatusV1Schema = z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  templateVersion: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  reporterMaterializationRef: PluginMachineMaterializationRefV1Schema,
  // The host stamps the exact admitted plugin generation. Legacy persisted
  // rows omit it and therefore cannot prove recovery authority.
  reporterImmutableGenerationId: asProtocolZod(PluginUiImmutableGenerationIdV1Schema).optional(),
  state: AutomationEventSourceStatusStateV1Schema,
  code: AutomationEventSourceStatusCodeV1Schema.exclude(['none']).nullable(),
  lastObservedAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA.nullable(),
  lastDispositionAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA.nullable(),
  nextRetryAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA.nullable(),
  observedCount: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  admittedCount: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  skippedCount: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  revision: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
}).strict();
export type AutomationEventSourceStatusV1 = z.infer<typeof AutomationEventSourceStatusV1Schema>;

export const AutomationEventSourceCatalogStatusV1Schema = z.object({
  accountId: asProtocolZod(HostIdentifierV1Schema),
  eventPluginId: z.string().min(1).max(256),
  reporterMaterializationRef: PluginMachineMaterializationRefV1Schema,
  scopeKey: AutomationEventSourceCatalogScopeKeyV1Schema,
  observedRevision: UNSIGNED_DECIMAL_BIGINT_SCHEMA,
  adoptedRevision: UNSIGNED_DECIMAL_BIGINT_SCHEMA.nullable(),
  state: AutomationEventSourceCatalogStatusStateV1Schema,
  scanStartedAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA.nullable(),
  nextRetryAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA.nullable(),
  reportedAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  revision: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
}).strict();
export type AutomationEventSourceCatalogStatusV1 = z.infer<typeof AutomationEventSourceCatalogStatusV1Schema>;

/**
 * Server-owned admission endpoint for the distinct Conversation trigger. The
 * signed caller frame is separate from immutable Action input so a plugin
 * cannot select a machine or materialization through its payload.
 */
export const AutomationConversationActionHttpPathsV1 = Object.freeze({
  'automation.conversation.targets.list': '/v1/automations/conversation/targets/list',
  'automation.conversation.target.verify': '/v1/automations/conversation/target/verify',
  'automation.conversation.admit': '/v1/automations/conversation/admit',
} as const satisfies Readonly<Record<AutomationConversationActionIdV1, string>>);

export const AutomationConversationActionHttpCallerV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  materialization: PluginMachineMaterializationRefV1Schema,
}).strict().superRefine((caller, context) => {
  if (caller.pluginId !== caller.materialization.pluginId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['materialization', 'pluginId'],
      message: 'Caller pluginId must match the stamped materialization pluginId',
    });
  }
});
export type AutomationConversationActionHttpCallerV1 = z.infer<
  typeof AutomationConversationActionHttpCallerV1Schema
>;

export const AutomationConversationActionHttpRequestSchemasV1 = Object.freeze({
  'automation.conversation.targets.list': z.object({
    v: z.literal(1),
    caller: AutomationConversationActionHttpCallerV1Schema,
    input: AutomationConversationTargetsListInputV1Schema,
  }).strict(),
  'automation.conversation.target.verify': z.object({
    v: z.literal(1),
    caller: AutomationConversationActionHttpCallerV1Schema,
    input: AutomationConversationTargetVerifyInputV1Schema,
  }).strict(),
  'automation.conversation.admit': z.object({
    v: z.literal(1),
    caller: AutomationConversationActionHttpCallerV1Schema,
    input: AutomationConversationAdmitInputV1Schema,
  }).strict().superRefine((request, context) => {
    // Any plugin may admit a Conversation and receive its own reply. The frozen
    // delivery target must stay inside the admitting plugin: naming another
    // plugin's contribution would misroute a user's reply out of its owner.
    if (!isAutomationConversationResultDeliveryOwnedByCallerV1({
      callerPluginId: request.caller.pluginId,
      resultDelivery: request.input.resultDelivery,
    })) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['input', 'resultDelivery', 'actionRef', 'pluginId'],
        message: 'Result delivery must target the admitting plugin\'s own Action contribution',
      });
    }
  }),
} as const satisfies Readonly<Record<AutomationConversationActionIdV1, z.ZodTypeAny>>);
export type AutomationConversationTargetsListHttpRequestV1 = z.infer<
  typeof AutomationConversationActionHttpRequestSchemasV1['automation.conversation.targets.list']
>;
export type AutomationConversationTargetVerifyHttpRequestV1 = z.infer<
  typeof AutomationConversationActionHttpRequestSchemasV1['automation.conversation.target.verify']
>;
export type AutomationConversationAdmitHttpRequestV1 = z.infer<
  typeof AutomationConversationActionHttpRequestSchemasV1['automation.conversation.admit']
>;
export type AutomationConversationActionHttpRequestV1 =
  | AutomationConversationTargetsListHttpRequestV1
  | AutomationConversationTargetVerifyHttpRequestV1
  | AutomationConversationAdmitHttpRequestV1;

export const AutomationEventActionHttpPathsV1 = Object.freeze({
  'automation.event.sources.list': '/v1/automations/events/sources/list',
  'automation.event.admit': '/v1/automations/events/admit',
  'automation.event.source.status.report': '/v1/automations/events/source-status/report',
} as const satisfies Readonly<Record<AutomationEventActionIdV1, string>>);

export const AutomationEventActionHttpCallerV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema).optional(),
  materialization: PluginMachineMaterializationRefV1Schema,
  // The host derives this from the admitted immutable contribution generation;
  // plugin Action input never supplies caller provenance.
  immutableGenerationId: asProtocolZod(PluginUiImmutableGenerationIdV1Schema).optional(),
}).strict().superRefine((caller, context) => {
  if (caller.pluginId !== caller.materialization.pluginId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['materialization', 'pluginId'],
      message: 'Caller pluginId must match the stamped materialization pluginId',
    });
  }
});
export type AutomationEventActionHttpCallerV1 = z.infer<typeof AutomationEventActionHttpCallerV1Schema>;

/**
 * Private server-to-host definition projection. This deliberately reuses the
 * Event host caller frame while remaining outside the public Action family.
 */
export const AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1 =
  '/v1/automations/events/stored-definitions/read';

export const AutomationEventStoredDefinitionsReadHttpRequestV1Schema = z.object({
  v: z.literal(1),
  caller: AutomationEventActionHttpCallerV1Schema,
  input: AutomationEventSourcesListInputV1Schema,
  // Host-only custody context for a currently claimed generic Webhook
  // invocation. This stays outside the plugin Action input and lets the
  // stored-definition owner reject a retargeted or expired delivery before it
  // discloses an endpoint-local source projection.
  webhookInvocationReference: PluginWebhookInvocationReferenceV1Schema.optional(),
}).strict();
export type AutomationEventStoredDefinitionsReadHttpRequestV1 = z.infer<
  typeof AutomationEventStoredDefinitionsReadHttpRequestV1Schema
>;

export const AutomationEventAdmitPlainHttpRequestV1Schema = z.object({
  v: z.literal(1),
  caller: AutomationEventActionHttpCallerV1Schema,
  input: AutomationEventAdmitHttpInputV1Schema,
  hostEvidence: AutomationEventAdmitPlainHostEvidenceV1Schema,
}).strict();

/**
 * The E2EE arm deliberately has no `input`.  This is the one signed body E2
 * receives from E3 and forwards unchanged, so no plugin payload, source
 * identity, schema, or plaintext template can enter the server path.
 */
export const AutomationEventAdmitEncryptedHttpRequestV1Schema = z.object({
  v: z.literal(1),
  caller: AutomationEventActionHttpCallerV1Schema,
  hostEvidence: AutomationEventAdmitEncryptedHostEvidenceV1Schema,
}).strict();

export const AutomationEventAdmitHttpRequestV1Schema = z.union([
  AutomationEventAdmitPlainHttpRequestV1Schema,
  AutomationEventAdmitEncryptedHttpRequestV1Schema,
]).superRefine((value, context) => {
  if (readAutomationEventAdmitHttpRequestCanonicalUtf8ByteLengthV1(value)
    > MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Event admission HTTP request exceeds the canonical byte limit',
    });
  }
});
export type AutomationEventAdmitPlainHttpRequestV1 = z.infer<
  typeof AutomationEventAdmitPlainHttpRequestV1Schema
>;
export type AutomationEventAdmitEncryptedHttpRequestV1 = z.infer<
  typeof AutomationEventAdmitEncryptedHttpRequestV1Schema
>;
export type AutomationEventAdmitHttpRequestV1 = z.infer<
  typeof AutomationEventAdmitHttpRequestV1Schema
>;

export const AutomationEventActionHttpRequestSchemasV1 = Object.freeze({
  'automation.event.sources.list': z.object({
    v: z.literal(1),
    caller: AutomationEventActionHttpCallerV1Schema,
    input: AutomationEventSourcesListInputV1Schema,
  }).strict(),
  'automation.event.admit': AutomationEventAdmitHttpRequestV1Schema,
  'automation.event.source.status.report': z.object({
    v: z.literal(1),
    caller: AutomationEventActionHttpCallerV1Schema,
    input: AutomationEventSourceStatusReportV1Schema,
  }).strict(),
} as const satisfies Readonly<Record<AutomationEventActionIdV1, z.ZodTypeAny>>);

/**
 * The one normalized host request shape for each Event action. E2 transport
 * implementations receive this boundary value, never raw plugin Action input
 * plus a parallel caller/evidence tuple.
 */
export type AutomationEventActionHttpRequestByIdV1 = {
  [TActionId in AutomationEventActionIdV1]: z.infer<
    (typeof AutomationEventActionHttpRequestSchemasV1)[TActionId]
  >;
};
export type AutomationEventActionHttpRequestV1 =
  AutomationEventActionHttpRequestByIdV1[AutomationEventActionIdV1];

export type AutomationEventAdmissionEvidenceV1 = AutomationOccurrenceEvidenceV1;
export type AutomationEventSourceSelectorIdV1 = AutomationSourceSelectorIdV1;
export type AutomationEventSourceDefinitionTransportV1 = AutomationEventSourceObservationTransportV1;
export type AutomationEventWebhookEndpointIdV1 = PluginWebhookEndpointIdV1;
export type AutomationEventWatcherMaterializationRefV1 = PluginMachineMaterializationRefV1;
