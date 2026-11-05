import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64, readCanonicalPaddedBase64DecodedLength } from '../crypto/base64.js';
import { parseSerializedJsonValue } from '../crypto/serializedJsonValue.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import {
  AutomationStoredContentEnvelopeV1Schema,
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
  type AutomationStoredContentEnvelopeV1,
} from '../automations/automationStoredContentEnvelopeV1.js';
import { preservedBoundedNfcString } from '../strings/preservedBoundedNfcString.js';
import { WorkflowAcceptedSnapshotListingV1Schema, WorkflowAcceptedSnapshotV1Schema, type WorkflowAcceptedSnapshotListingV1 } from './workflowDefinitionV1.js';
import {
  WorkflowCheckpointEnvelopeV1Schema,
  WorkflowDecimalV1Schema,
  WorkflowFinalResultV1Schema,
  WorkflowInvocationRecordIdSchema,
  WorkflowProgressEnvelopeV1Schema,
  WorkflowRunIdV1Schema,
} from './workflowProgressV1.js';

const WorkflowAccountIdV1Schema = preservedBoundedNfcString(191, 'Account ids');
const WorkflowStoredBindingBaseV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  accountId: WorkflowAccountIdV1Schema,
  runId: WorkflowRunIdV1Schema,
}));

export const WorkflowAcceptedSnapshotStoredBindingV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkflowStoredBindingBaseV1Schema, {
  purpose: z.literal('accepted_snapshot'),
})));
export const WorkflowInvocationProgressStoredBindingV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkflowStoredBindingBaseV1Schema, {
  purpose: z.literal('invocation_progress'),
  recordId: WorkflowInvocationRecordIdSchema,
  sequence: WorkflowDecimalV1Schema,
  parentRecordId: z.nullable(WorkflowInvocationRecordIdSchema),
  memberOrdinal: WorkflowDecimalV1Schema,
  attempt: WorkflowDecimalV1Schema,
})));
export const WorkflowCheckpointStoredBindingV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkflowStoredBindingBaseV1Schema, {
  purpose: z.literal('checkpoint'),
})));
export const WorkflowFinalResultStoredBindingV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkflowStoredBindingBaseV1Schema, {
  purpose: z.literal('final_result'),
})));

export const WorkflowStoredContentBindingV1Schema = lazyZodSchema(() => z.discriminatedUnion('purpose', [
  WorkflowAcceptedSnapshotStoredBindingV1Schema,
  WorkflowInvocationProgressStoredBindingV1Schema,
  WorkflowCheckpointStoredBindingV1Schema,
  WorkflowFinalResultStoredBindingV1Schema,
]));
export type WorkflowStoredContentBindingV1 = z.infer<typeof WorkflowStoredContentBindingV1Schema>;
export type WorkflowAcceptedSnapshotStoredBindingV1 = z.infer<typeof WorkflowAcceptedSnapshotStoredBindingV1Schema>;
export type WorkflowInvocationProgressStoredBindingV1 = z.infer<typeof WorkflowInvocationProgressStoredBindingV1Schema>;
export type WorkflowCheckpointStoredBindingV1 = z.infer<typeof WorkflowCheckpointStoredBindingV1Schema>;
export type WorkflowFinalResultStoredBindingV1 = z.infer<typeof WorkflowFinalResultStoredBindingV1Schema>;

const WorkflowAcceptedSnapshotStoredPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2), binding: WorkflowAcceptedSnapshotStoredBindingV1Schema,
  content: WorkflowAcceptedSnapshotV1Schema,
}));
// Run lists read the same authenticated payload through the listed facts only.
const WorkflowAcceptedSnapshotListingStoredPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2), binding: WorkflowAcceptedSnapshotStoredBindingV1Schema,
  content: WorkflowAcceptedSnapshotListingV1Schema,
}));
const WorkflowInvocationProgressStoredPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2), binding: WorkflowInvocationProgressStoredBindingV1Schema,
  content: WorkflowProgressEnvelopeV1Schema,
}));
const WorkflowCheckpointStoredPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2), binding: WorkflowCheckpointStoredBindingV1Schema,
  content: WorkflowCheckpointEnvelopeV1Schema,
}));
const WorkflowFinalResultStoredPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2), binding: WorkflowFinalResultStoredBindingV1Schema,
  content: WorkflowFinalResultV1Schema,
}));

export const WorkflowStoredContentEnvelopeV1Schema = AutomationStoredContentEnvelopeV1Schema;
export type WorkflowStoredContentEnvelopeV1 = z.infer<typeof WorkflowStoredContentEnvelopeV1Schema>;

export type WorkflowStoredContentOpenFailureV1 =
  | Readonly<{ kind: 'materialUnavailable' }>
  | Readonly<{ kind: 'contentInvalid' }>
  | Readonly<{ kind: 'modeMismatch' }>
  | Readonly<{ kind: 'bindingMismatch' }>;
export type WorkflowStoredContentOuterValidationV1 =
  | Readonly<{ kind: 'available'; envelope: WorkflowStoredContentEnvelopeV1 }>
  | Exclude<WorkflowStoredContentOpenFailureV1, Readonly<{ kind: 'materialUnavailable' }>>;

type WorkflowStoredEnvelopeSealModeV1 =
  | Readonly<{ mode: 'plain' }>
  | Readonly<{
      mode: 'e2ee'; runDataKey: Uint8Array;
      randomBytes: (length: number) => Uint8Array;
    }>;

// Development direct cut: Account-derived ciphertext is intentionally not readable.
const WORKFLOW_RUN_CIPHERTEXT_PREFIX = 'wfr1:';
function readWorkflowRunCiphertext(ciphertext: string): Uint8Array | null {
  if (!ciphertext.startsWith(WORKFLOW_RUN_CIPHERTEXT_PREFIX)) return null;
  const encoded = ciphertext.slice(WORKFLOW_RUN_CIPHERTEXT_PREFIX.length);
  const length = readCanonicalPaddedBase64DecodedLength(encoded);
  if (length === null || length < tweetnacl.secretbox.nonceLength + tweetnacl.secretbox.overheadLength) return null;
  const bytes = decodeBase64(encoded);
  return encodeBase64(bytes) === encoded ? bytes : null;
}

function isWorkflowRunDataKey(key: unknown): key is Uint8Array {
  return key instanceof Uint8Array && key.byteLength === tweetnacl.secretbox.keyLength;
}

// Carry the purpose together with its admitted payload; public openers can
// narrow this union without admitting the content a second time.
type ParsedWorkflowStoredPayloadV1 =
  | Readonly<{ purpose: 'accepted_snapshot'; payload: z.infer<typeof WorkflowAcceptedSnapshotStoredPayloadV1Schema> }>
  | Readonly<{ purpose: 'accepted_snapshot_listing'; payload: z.infer<typeof WorkflowAcceptedSnapshotListingStoredPayloadV1Schema> }>
  | Readonly<{ purpose: 'invocation_progress'; payload: z.infer<typeof WorkflowInvocationProgressStoredPayloadV1Schema> }>
  | Readonly<{ purpose: 'checkpoint'; payload: z.infer<typeof WorkflowCheckpointStoredPayloadV1Schema> }>
  | Readonly<{ purpose: 'final_result'; payload: z.infer<typeof WorkflowFinalResultStoredPayloadV1Schema> }>;

function parsePayloadForBinding(
  binding: WorkflowStoredContentBindingV1,
  value: unknown,
  storedRead = false,
  listing = false,
): ParsedWorkflowStoredPayloadV1 | null {
  switch (binding.purpose) {
    case 'accepted_snapshot': {
      if (listing) {
        const parsed = createStoredReadSchema(WorkflowAcceptedSnapshotListingStoredPayloadV1Schema).safeParse(value);
        return parsed.success ? { purpose: 'accepted_snapshot_listing', payload: parsed.data } : null;
      }
      const parsed = (storedRead ? createStoredReadSchema(WorkflowAcceptedSnapshotStoredPayloadV1Schema) : WorkflowAcceptedSnapshotStoredPayloadV1Schema).safeParse(value);
      return parsed.success ? { purpose: binding.purpose, payload: parsed.data } : null;
    }
    case 'invocation_progress': {
      const parsed = (storedRead ? createStoredReadSchema(WorkflowInvocationProgressStoredPayloadV1Schema) : WorkflowInvocationProgressStoredPayloadV1Schema).safeParse(value);
      if (!parsed.success || parsed.data.content.attempt !== parsed.data.binding.attempt) return null;
      if (parsed.data.binding.attempt === '0'
        && parsed.data.content.logicalInvocationRecordId !== parsed.data.binding.recordId) return null;
      return { purpose: binding.purpose, payload: parsed.data };
    }
    case 'checkpoint': {
      const parsed = (storedRead ? createStoredReadSchema(WorkflowCheckpointStoredPayloadV1Schema) : WorkflowCheckpointStoredPayloadV1Schema).safeParse(value);
      return parsed.success ? { purpose: binding.purpose, payload: parsed.data } : null;
    }
    case 'final_result': {
      const parsed = (storedRead ? createStoredReadSchema(WorkflowFinalResultStoredPayloadV1Schema) : WorkflowFinalResultStoredPayloadV1Schema).safeParse(value);
      return parsed.success ? { purpose: binding.purpose, payload: parsed.data } : null;
    }
  }
}

function sameBinding(left: WorkflowStoredContentBindingV1, right: WorkflowStoredContentBindingV1): boolean {
  return createCanonicalJsonSigningInput(left) === createCanonicalJsonSigningInput(right);
}

export function validateWorkflowStoredEnvelopeOuterForModeV1(params: Readonly<{
  mode: 'plain' | 'e2ee'; binding: WorkflowStoredContentBindingV1; envelope: unknown;
}>): WorkflowStoredContentOuterValidationV1 {
  const validated = readWorkflowStoredEnvelopeOuterForModeV1(params);
  return validated.kind === 'available'
    ? { kind: 'available', envelope: validated.envelope }
    : validated;
}

type ReadWorkflowStoredEnvelopeOuterV1 =
  | Readonly<{ kind: 'available'; envelope: Extract<WorkflowStoredContentEnvelopeV1, { t: 'plain' }>; bytes: null; payload: ParsedWorkflowStoredPayloadV1 }>
  | Readonly<{ kind: 'available'; envelope: Extract<WorkflowStoredContentEnvelopeV1, { t: 'encrypted' }>; bytes: Uint8Array; binding: WorkflowStoredContentBindingV1 }>
  | Exclude<WorkflowStoredContentOuterValidationV1, { kind: 'available' }>;

// Keep the validated ciphertext with this read so opening does not decode and
// re-encode it again. The public outer-only validator still returns no bytes.
function readWorkflowStoredEnvelopeOuterForModeV1(params: Readonly<{
  mode: 'plain' | 'e2ee'; binding: WorkflowStoredContentBindingV1; envelope: unknown; listing?: boolean;
}>): ReadWorkflowStoredEnvelopeOuterV1 {
  const binding = WorkflowStoredContentBindingV1Schema.safeParse(params.binding);
  const envelope = createStoredReadSchema(WorkflowStoredContentEnvelopeV1Schema).safeParse(params.envelope);
  if (!binding.success || !envelope.success) return { kind: 'contentInvalid' };
  if ((params.mode === 'plain' && envelope.data.t !== 'plain')
    || (params.mode === 'e2ee' && envelope.data.t !== 'encrypted')) {
    return { kind: 'modeMismatch' };
  }
  if (envelope.data.t === 'encrypted') {
    const bytes = readWorkflowRunCiphertext(envelope.data.c);
    return bytes
      ? { kind: 'available', envelope: envelope.data, bytes, binding: binding.data } : { kind: 'contentInvalid' };
  }
  const payload = parsePayloadForBinding(binding.data, envelope.data.v, true, params.listing);
  if (!payload) return { kind: 'contentInvalid' };
  return sameBinding(payload.payload.binding, binding.data)
    ? { kind: 'available', envelope: envelope.data, bytes: null, payload }
    : { kind: 'bindingMismatch' };
}

function sealWorkflowStoredEnvelopeV1(params: Readonly<{
  binding: WorkflowStoredContentBindingV1; payload: unknown;
}> & WorkflowStoredEnvelopeSealModeV1): WorkflowStoredContentEnvelopeV1 {
  const binding = WorkflowStoredContentBindingV1Schema.parse(params.binding);
  const payload = parsePayloadForBinding(binding, params.payload);
  if (!payload) throw new TypeError('Invalid Workflow stored content payload');
  if (params.mode === 'plain') {
    return WorkflowStoredContentEnvelopeV1Schema.parse({ t: 'plain', v: payload.payload });
  }
  if (!isWorkflowRunDataKey(params.runDataKey)) throw new TypeError('Workflow run data key must be 32 bytes');
  const nonce = params.randomBytes(tweetnacl.secretbox.nonceLength);
  if (nonce.length !== tweetnacl.secretbox.nonceLength) throw new TypeError('Invalid Workflow encryption nonce');
  // Content is not an identity digest: schema property order carries the author's presentation.
  const boxed = tweetnacl.secretbox(new TextEncoder().encode(JSON.stringify(payload.payload)), nonce, params.runDataKey);
  const bytes = new Uint8Array(nonce.length + boxed.length);
  bytes.set(nonce); bytes.set(boxed, nonce.length);
  return WorkflowStoredContentEnvelopeV1Schema.parse({
    t: 'encrypted',
    c: WORKFLOW_RUN_CIPHERTEXT_PREFIX + encodeBase64(bytes),
  });
}

function openWorkflowStoredEnvelopeV1(params: Readonly<{
  mode: 'plain' | 'e2ee'; binding: WorkflowStoredContentBindingV1;
  envelope: unknown; runDataKey?: Uint8Array; listing?: boolean;
}>): Readonly<{ kind: 'available'; payload: ParsedWorkflowStoredPayloadV1 }> | WorkflowStoredContentOpenFailureV1 {
  const outer = readWorkflowStoredEnvelopeOuterForModeV1(params);
  if (outer.kind !== 'available') return outer;
  let rawPayload: unknown;
  if (outer.bytes === null) {
    return { kind: 'available', payload: outer.payload };
  } else {
    if (params.runDataKey === undefined) return { kind: 'materialUnavailable' };
    if (!isWorkflowRunDataKey(params.runDataKey)) return { kind: 'contentInvalid' };
    const bytes = outer.bytes;
    const opened = tweetnacl.secretbox.open(bytes.subarray(tweetnacl.secretbox.nonceLength),
      bytes.subarray(0, tweetnacl.secretbox.nonceLength), params.runDataKey);
    if (!opened) return { kind: 'contentInvalid' };
    try { rawPayload = parseSerializedJsonValue(new TextDecoder().decode(opened)); }
    catch { return { kind: 'contentInvalid' }; }
  }
  const payload = parsePayloadForBinding(outer.binding, rawPayload, true, params.listing);
  if (!payload) return { kind: 'contentInvalid' };
  if (!sameBinding(payload.payload.binding, outer.binding)) return { kind: 'bindingMismatch' };
  return { kind: 'available', payload };
}

export function sealWorkflowAcceptedSnapshotStoredEnvelopeV1(params: Readonly<{
  binding: WorkflowAcceptedSnapshotStoredBindingV1;
  acceptedSnapshot: z.infer<typeof WorkflowAcceptedSnapshotV1Schema>;
}> & WorkflowStoredEnvelopeSealModeV1): WorkflowStoredContentEnvelopeV1 {
  return sealWorkflowStoredEnvelopeV1({
    ...params, payload: { v: 2, binding: params.binding, content: params.acceptedSnapshot },
  });
}
export function openWorkflowAcceptedSnapshotStoredEnvelopeV1(params: Readonly<{
  mode: 'plain' | 'e2ee'; binding: WorkflowAcceptedSnapshotStoredBindingV1;
  envelope: unknown; runDataKey?: Uint8Array;
}>): Readonly<{ kind: 'available'; content: z.infer<typeof WorkflowAcceptedSnapshotV1Schema> }> | WorkflowStoredContentOpenFailureV1 {
  const opened = openWorkflowStoredEnvelopeV1(params);
  if (opened.kind !== 'available') return opened;
  return opened.payload.purpose === 'accepted_snapshot'
    ? { kind: 'available' as const, content: opened.payload.payload.content }
    : { kind: 'contentInvalid' as const };
}

/** Run lists: the authenticated accepted facts a row shows, without admitting the frozen program. */
export function openWorkflowAcceptedSnapshotListingStoredEnvelopeV1(params: Readonly<{
  mode: 'plain' | 'e2ee'; binding: WorkflowAcceptedSnapshotStoredBindingV1;
  envelope: unknown; runDataKey?: Uint8Array;
}>): Readonly<{ kind: 'available'; content: WorkflowAcceptedSnapshotListingV1 }> | WorkflowStoredContentOpenFailureV1 {
  const opened = openWorkflowStoredEnvelopeV1({ ...params, listing: true });
  if (opened.kind !== 'available') return opened;
  return opened.payload.purpose === 'accepted_snapshot_listing'
    ? { kind: 'available' as const, content: opened.payload.payload.content }
    : { kind: 'contentInvalid' as const };
}

export function sealWorkflowProgressStoredEnvelopeV1(params: Readonly<{
  binding: WorkflowInvocationProgressStoredBindingV1;
  progress: z.infer<typeof WorkflowProgressEnvelopeV1Schema>;
}> & WorkflowStoredEnvelopeSealModeV1): WorkflowStoredContentEnvelopeV1 {
  return sealWorkflowStoredEnvelopeV1({
    ...params, payload: { v: 2, binding: params.binding, content: params.progress },
  });
}
export function openWorkflowProgressStoredEnvelopeV1(params: Readonly<{
  mode: 'plain' | 'e2ee'; binding: WorkflowInvocationProgressStoredBindingV1;
  envelope: unknown; runDataKey?: Uint8Array;
}>): Readonly<{ kind: 'available'; content: z.infer<typeof WorkflowProgressEnvelopeV1Schema> }> | WorkflowStoredContentOpenFailureV1 {
  const opened = openWorkflowStoredEnvelopeV1(params);
  if (opened.kind !== 'available') return opened;
  return opened.payload.purpose === 'invocation_progress'
    ? { kind: 'available' as const, content: opened.payload.payload.content }
    : { kind: 'contentInvalid' as const };
}

export function sealWorkflowCheckpointStoredEnvelopeV1(params: Readonly<{
  binding: WorkflowCheckpointStoredBindingV1;
  checkpoint: z.infer<typeof WorkflowCheckpointEnvelopeV1Schema>;
}> & WorkflowStoredEnvelopeSealModeV1): WorkflowStoredContentEnvelopeV1 {
  return sealWorkflowStoredEnvelopeV1({
    ...params, payload: { v: 2, binding: params.binding, content: params.checkpoint },
  });
}
export function openWorkflowCheckpointStoredEnvelopeV1(params: Readonly<{
  mode: 'plain' | 'e2ee'; binding: WorkflowCheckpointStoredBindingV1;
  envelope: unknown; runDataKey?: Uint8Array;
}>): Readonly<{ kind: 'available'; content: z.infer<typeof WorkflowCheckpointEnvelopeV1Schema> }> | WorkflowStoredContentOpenFailureV1 {
  const opened = openWorkflowStoredEnvelopeV1(params);
  if (opened.kind !== 'available') return opened;
  return opened.payload.purpose === 'checkpoint'
    ? { kind: 'available' as const, content: opened.payload.payload.content }
    : { kind: 'contentInvalid' as const };
}

export function sealWorkflowFinalResultStoredEnvelopeV1(params: Readonly<{
  binding: WorkflowFinalResultStoredBindingV1;
  finalResult: z.infer<typeof WorkflowFinalResultV1Schema>;
}> & WorkflowStoredEnvelopeSealModeV1): WorkflowStoredContentEnvelopeV1 {
  return sealWorkflowStoredEnvelopeV1({
    ...params, payload: { v: 2, binding: params.binding, content: params.finalResult },
  });
}
export function openWorkflowFinalResultStoredEnvelopeV1(params: Readonly<{
  mode: 'plain' | 'e2ee'; binding: WorkflowFinalResultStoredBindingV1;
  envelope: unknown; runDataKey?: Uint8Array;
}>): Readonly<{ kind: 'available'; content: z.infer<typeof WorkflowFinalResultV1Schema> }> | WorkflowStoredContentOpenFailureV1 {
  const opened = openWorkflowStoredEnvelopeV1(params);
  if (opened.kind !== 'available') return opened;
  return opened.payload.purpose === 'final_result'
    ? { kind: 'available' as const, content: opened.payload.payload.content }
    : { kind: 'contentInvalid' as const };
}

export function serializeWorkflowStoredContentEnvelopeV1(envelope: unknown): string {
  return JSON.stringify(WorkflowStoredContentEnvelopeV1Schema.parse(envelope));
}

export function parseWorkflowStoredContentEnvelopeV1(serialized: unknown): WorkflowStoredContentEnvelopeV1 | null {
  if (typeof serialized !== 'string'
    || new TextEncoder().encode(serialized).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES) return null;
  try {
    const parsed = createStoredReadSchema(WorkflowStoredContentEnvelopeV1Schema).safeParse(JSON.parse(serialized));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
