import { createHash } from 'node:crypto';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { defineAccountCollection } from '@happier-dev/plugin-sdk/collections';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
  GITHUB_AUTOMATION_EVENT_LOCAL_IDS,
  isGithubAutomationEventLocalId,
  type GithubAutomationEventLocalIdV1,
} from '../githubAutomationEvents.js';
import {
  GITHUB_PLUGIN_ID,
} from './githubProviderContracts.js';

/** Provider-owned Account Collection for repository-source GitHub Event checkpoints. */
export const GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION_ID = 'automation-event-checkpoints-v1';
export const GITHUB_AUTOMATION_EVENT_CHECKPOINT_CONTRACT_VERSION = 1;
export const GITHUB_AUTOMATION_EVENT_CHECKPOINT_CURSOR_AND_CONTINUITY_MAX_UTF8_BYTES = 64 * 1024;

export const GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD = {
  id: 'id',
  version: 'v',
  automationId: 'automation-id',
  triggerId: 'trigger-id',
  eventPluginId: 'event-plugin-id',
  eventLocalId: 'event-local-id',
  sourceSelectorId: 'source-selector-id',
  payload: 'payload',
} as const;

export const GITHUB_AUTOMATION_EVENT_CHECKPOINT_INDEX_ID = {
  byAutomationEventSource: 'by-automation-event-source',
} as const;

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const MAX_HOST_ID_LENGTH = 256;
const MAX_SOURCE_INSTANCE_ID_LENGTH = 512;
const MAX_OCCURRENCE_ID_LENGTH = 2_048;
const MAX_CHECKPOINT_ROW_ENCODED_BYTES = 96 * 1024;
const CHECKPOINT_ID_DOMAIN = 'happier.scm-github.automation-event-checkpoint.v1';
const textEncoder = new TextEncoder();
const JSON_VALUE_SCHEMA = {} satisfies PluginJsonSchema;
const NULL_SCHEMA = { type: 'null' } satisfies PluginJsonSchema;
const NON_NEGATIVE_SAFE_INTEGER_SCHEMA = {
  type: 'integer',
  minimum: 0,
  maximum: MAX_SAFE_INTEGER,
} satisfies PluginJsonSchema;
const POSITIVE_SAFE_INTEGER_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_SAFE_INTEGER,
} satisfies PluginJsonSchema;
const HOST_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_HOST_ID_LENGTH,
} satisfies PluginJsonSchema;
const SOURCE_INSTANCE_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_SOURCE_INSTANCE_ID_LENGTH,
} satisfies PluginJsonSchema;
const OCCURRENCE_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_OCCURRENCE_ID_LENGTH,
} satisfies PluginJsonSchema;
const ROW_ID_SCHEMA = {
  type: 'string',
  minLength: 43,
  maxLength: 43,
  pattern: '^[A-Za-z0-9_-]{43}$',
} satisfies PluginJsonSchema;

const CHECKPOINT_PAYLOAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sourceInstanceId: SOURCE_INSTANCE_ID_SCHEMA,
    sourceContractVersion: POSITIVE_SAFE_INTEGER_SCHEMA,
    checkpointContractVersion: { type: 'integer', const: GITHUB_AUTOMATION_EVENT_CHECKPOINT_CONTRACT_VERSION },
    cursor: JSON_VALUE_SCHEMA,
    lastContiguousOccurrenceId: { anyOf: [OCCURRENCE_ID_SCHEMA, NULL_SCHEMA] },
    baseline: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['currentHead', 'boundedImport'] },
        establishedAt: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
      },
      required: ['kind', 'establishedAt'],
    },
    // Protocol `AutomationTriggerRevisionSchema` is nonnegative and the
    // canonical trigger create writers mint revision 0, so a first baseline
    // must be persistable at exactly the revision its admitted definition
    // carries.
    lastEvaluatedTriggerRevision: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
    continuity: JSON_VALUE_SCHEMA,
  },
  required: [
    'sourceInstanceId',
    'sourceContractVersion',
    'checkpointContractVersion',
    'cursor',
    'lastContiguousOccurrenceId',
    'baseline',
    'lastEvaluatedTriggerRevision',
    'continuity',
  ],
} satisfies PluginJsonSchema;

export type GithubAutomationEventCheckpointPayloadV1 = Readonly<{
  sourceInstanceId: string;
  sourceContractVersion: number;
  checkpointContractVersion: 1;
  cursor: JsonValue;
  lastContiguousOccurrenceId: string | null;
  baseline: Readonly<{ kind: 'currentHead' | 'boundedImport'; establishedAt: number }>;
  lastEvaluatedTriggerRevision: number;
  continuity: JsonValue;
}>;

export type GithubAutomationEventCheckpointRowV1 = Readonly<{
  [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.id]: string;
  [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.version]: 1;
  [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.automationId]: string;
  [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.triggerId]: string;
  [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventPluginId]: typeof GITHUB_PLUGIN_ID;
  [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId]: GithubAutomationEventLocalIdV1;
  [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.sourceSelectorId]: string;
  [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.payload]: GithubAutomationEventCheckpointPayloadV1;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function encodedCursorAndContinuityBytes(input: Readonly<{
  cursor: JsonValue;
  continuity: JsonValue;
}>): number {
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  return new TextEncoder().encode(encoded).byteLength;
}

/**
 * This is the exact stable wire encoding already used for the persisted row
 * key: big-endian 32-bit byte lengths followed by UTF-8 parts. It stays local
 * because the row ID is a provider-owned opaque identity, not a Protocol DTO.
 */
function encodeCanonicalLengthDelimited(parts: readonly string[]): Uint8Array {
  const encodedParts = parts.map((part) => textEncoder.encode(part));
  const totalLength = encodedParts.reduce((total, part) => total + 4 + part.byteLength, 0);
  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const part of encodedParts) {
    view.setUint32(offset, part.byteLength, false);
    offset += 4;
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function computeCheckpointRowId(parts: readonly string[]): string {
  return createHash('sha256')
    .update(encodeCanonicalLengthDelimited([CHECKPOINT_ID_DOMAIN, ...parts]))
    .digest('base64url');
}

/**
 * One opaque checkpoint key per Automation trigger occurrence stream.
 * Provider reads may be coalesced process-locally, but mutable cursor and
 * retry/history-gap custody must remain independently owned by each trigger.
 */
export function createGithubAutomationEventCheckpointRowId(input: Readonly<{
  automationId: string;
  triggerId: string;
  eventRef: Readonly<{ pluginId: string; localId: string }>;
  sourceSelectorId: string;
}>): string {
  return computeCheckpointRowId([
    input.automationId,
    input.triggerId,
    input.eventRef.pluginId,
    input.eventRef.localId,
    input.sourceSelectorId,
  ]);
}

export function isGithubAutomationEventCheckpointRowV1(value: unknown): value is GithubAutomationEventCheckpointRowV1 {
  if (!isRecord(value)) return false;
  const id = value[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.id];
  const version = value[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.version];
  const automationId = value[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.automationId];
  const triggerId = value[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.triggerId];
  const eventPluginId = value[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventPluginId];
  const eventLocalId = value[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId];
  const sourceSelectorId = value[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.sourceSelectorId];
  const payload = value[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.payload];
  if (version !== 1
    || !isBoundedString(id, 43)
    || !isBoundedString(automationId, MAX_HOST_ID_LENGTH)
    || !isBoundedString(triggerId, MAX_HOST_ID_LENGTH)
    || eventPluginId !== GITHUB_PLUGIN_ID
    || typeof eventLocalId !== 'string'
    || !isGithubAutomationEventLocalId(eventLocalId)
    || !isBoundedString(sourceSelectorId, MAX_HOST_ID_LENGTH)
    || !isRecord(payload)) return false;
  if (
    !isBoundedString(payload.sourceInstanceId, MAX_SOURCE_INSTANCE_ID_LENGTH)
    || !isPositiveSafeInteger(payload.sourceContractVersion)
    || payload.checkpointContractVersion !== GITHUB_AUTOMATION_EVENT_CHECKPOINT_CONTRACT_VERSION
    || (payload.lastContiguousOccurrenceId !== null
      && !isBoundedString(payload.lastContiguousOccurrenceId, MAX_OCCURRENCE_ID_LENGTH))
    || !isRecord(payload.baseline)
    || (payload.baseline.kind !== 'currentHead' && payload.baseline.kind !== 'boundedImport')
    || !isNonNegativeSafeInteger(payload.baseline.establishedAt)
    || !isNonNegativeSafeInteger(payload.lastEvaluatedTriggerRevision)
  ) return false;
  return id === createGithubAutomationEventCheckpointRowId({
    automationId,
    triggerId,
    eventRef: { pluginId: eventPluginId, localId: eventLocalId },
    sourceSelectorId,
  }) && encodedCursorAndContinuityBytes({
    cursor: payload.cursor as JsonValue,
    continuity: payload.continuity as JsonValue,
  }) <= GITHUB_AUTOMATION_EVENT_CHECKPOINT_CURSOR_AND_CONTINUITY_MAX_UTF8_BYTES;
}

export function createGithubAutomationEventCheckpointRowV1(input: Readonly<{
  checkpointRowId: string;
  automationId: string;
  triggerId: string;
  eventRef: Readonly<{ pluginId: string; localId: string }>;
  sourceSelectorId: string;
  sourceInstanceId: string;
  sourceContractVersion: number;
  cursor: JsonValue;
  lastContiguousOccurrenceId: string | null;
  baseline: Readonly<{ kind: 'currentHead' | 'boundedImport'; establishedAt: number }>;
  lastEvaluatedTriggerRevision: number;
  continuity: JsonValue;
}>): GithubAutomationEventCheckpointRowV1 {
  if (input.eventRef.pluginId !== GITHUB_PLUGIN_ID || !isGithubAutomationEventLocalId(input.eventRef.localId)) {
    throw new RangeError('GitHub Automation Event checkpoint requires a current semantic Event ref');
  }
  const expectedCheckpointRowId = createGithubAutomationEventCheckpointRowId({
    automationId: input.automationId,
    triggerId: input.triggerId,
    eventRef: input.eventRef,
    sourceSelectorId: input.sourceSelectorId,
  });
  if (input.checkpointRowId !== expectedCheckpointRowId) {
    throw new RangeError('GitHub Automation Event checkpoint row ID is invalid');
  }
  const row: GithubAutomationEventCheckpointRowV1 = Object.freeze({
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.id]: input.checkpointRowId,
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.version]: 1,
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.automationId]: input.automationId,
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.triggerId]: input.triggerId,
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventPluginId]: GITHUB_PLUGIN_ID,
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId]: input.eventRef.localId,
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.sourceSelectorId]: input.sourceSelectorId,
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.payload]: Object.freeze({
      sourceInstanceId: input.sourceInstanceId,
      sourceContractVersion: input.sourceContractVersion,
      checkpointContractVersion: GITHUB_AUTOMATION_EVENT_CHECKPOINT_CONTRACT_VERSION,
      cursor: input.cursor,
      lastContiguousOccurrenceId: input.lastContiguousOccurrenceId,
      baseline: Object.freeze({ ...input.baseline }),
      lastEvaluatedTriggerRevision: input.lastEvaluatedTriggerRevision,
      continuity: input.continuity,
    }),
  });
  if (!isGithubAutomationEventCheckpointRowV1(row)) {
    throw new RangeError('GitHub Automation Event checkpoint row is invalid');
  }
  return row;
}

/**
 * The source plugin owns its opaque cursor namespace. Only the identity tuple is
 * server-readable/indexable; source facts and cursor continuity stay private.
 */
export const GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION = defineAccountCollection({
  id: GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION_ID,
  schemaVersion: 1,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.id]: ROW_ID_SCHEMA,
      [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.version]: { type: 'integer', const: 1 },
      [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.automationId]: HOST_ID_SCHEMA,
      [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.triggerId]: HOST_ID_SCHEMA,
      [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventPluginId]: { type: 'string', const: GITHUB_PLUGIN_ID },
      [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId]: {
        type: 'string',
        enum: Object.values(GITHUB_AUTOMATION_EVENT_LOCAL_IDS),
      },
      [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.sourceSelectorId]: HOST_ID_SCHEMA,
      [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.payload]: CHECKPOINT_PAYLOAD_SCHEMA,
    },
    required: [
      GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.id,
      GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.version,
      GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.automationId,
      GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.triggerId,
      GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventPluginId,
      GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId,
      GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.sourceSelectorId,
      GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.payload,
    ],
  },
  rowIdField: GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.id,
  serverReadable: [
    GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.version,
    GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.automationId,
    GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.triggerId,
    GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventPluginId,
    GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId,
    GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.sourceSelectorId,
  ],
  indexes: [{
    id: GITHUB_AUTOMATION_EVENT_CHECKPOINT_INDEX_ID.byAutomationEventSource,
    // A trigger ID names one Automation globally. Keeping automationId here
    // would add no lookup authority and would exceed Collections' four-field
    // compound-index contract once the exact qualified Event and selector are
    // included.
    fields: [
      { field: GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.triggerId, direction: 'asc' },
      { field: GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventPluginId, direction: 'asc' },
      { field: GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId, direction: 'asc' },
      { field: GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.sourceSelectorId, direction: 'asc' },
    ],
  }],
  uiQueries: [],
  relations: [],
  // No field here is a mode-derived identity tag. The Trigger, Automation,
  // Event and selector IDs that address this row are host-known plaintext
  // facts, so an Account encryption-mode change cannot move it.
  identityFields: [],
  quota: { maxRowEncodedBytes: MAX_CHECKPOINT_ROW_ENCODED_BYTES },
});
