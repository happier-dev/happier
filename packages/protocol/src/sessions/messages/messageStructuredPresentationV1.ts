import { z } from 'zod';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

import {
  PluginContributionLocalIdSchema,
} from '../../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import {
  PluginTranscriptPresentationNodeV1Schema,
  type PluginTranscriptPresentationNodeV1,
} from '../../plugins/contributions/ui/index.js';

export const MESSAGE_STRUCTURED_PRESENTATION_V1_MAX_NODES = 256;
export const MESSAGE_STRUCTURED_PRESENTATION_V1_MAX_DEPTH = 16;
export const MESSAGE_STRUCTURED_PRESENTATION_V1_MAX_ENCODED_BYTES = 256 * 1024;

const textEncoder = new TextEncoder();

export const MessageStructuredPresentationOwnerV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
}).strict();
export type MessageStructuredPresentationOwnerV1 = z.infer<
  typeof MessageStructuredPresentationOwnerV1Schema
>;

const QualifiedActionReferenceV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  localId: asProtocolZod(PluginContributionLocalIdSchema),
}).strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inspectSnapshot(
  snapshot: PluginTranscriptPresentationNodeV1,
): Readonly<{
  nodeCount: number;
  maxDepth: number;
  unqualifiedActionPaths: readonly (readonly (string | number)[])[];
}> {
  let nodeCount = 0;
  let maxDepth = 0;
  const unqualifiedActionPaths: (readonly (string | number)[])[] = [];
  const stack: Array<Readonly<{
    node: PluginTranscriptPresentationNodeV1;
    depth: number;
    path: readonly (string | number)[];
  }>> = [{ node: snapshot, depth: 1, path: [] }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, current.depth);

    const record = current.node as Readonly<Record<string, unknown>>;
    if ((record.kind === 'action' || record.kind === 'item') && record.action !== undefined) {
      if (!QualifiedActionReferenceV1Schema.safeParse(record.action).success) {
        unqualifiedActionPaths.push([...current.path, 'action']);
      }
    }

    if (!Array.isArray(record.children)) continue;
    for (let index = record.children.length - 1; index >= 0; index -= 1) {
      const child = record.children[index];
      if (isRecord(child)) {
        stack.push({
          node: child as PluginTranscriptPresentationNodeV1,
          depth: current.depth + 1,
          path: [...current.path, 'children', index],
        });
      }
    }
  }

  return { nodeCount, maxDepth, unqualifiedActionPaths };
}

/**
 * Exact persisted immutable Message member. The UI contributions package owns
 * the transcript-node grammar; Message owns its persistence-only closure,
 * including qualified Action references and bounded serialized storage.
 */
export const MessageStructuredPresentationV1Schema = z.object({
  v: z.literal(1),
  profile: z.literal('pluginTranscriptV1'),
  owner: MessageStructuredPresentationOwnerV1Schema,
  snapshot: PluginTranscriptPresentationNodeV1Schema,
}).strict().superRefine((value, context) => {
  const inspected = inspectSnapshot(value.snapshot);
  if (inspected.nodeCount > MESSAGE_STRUCTURED_PRESENTATION_V1_MAX_NODES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['snapshot'],
      message: `Structured presentation exceeds ${MESSAGE_STRUCTURED_PRESENTATION_V1_MAX_NODES} nodes.`,
    });
  }
  if (inspected.maxDepth > MESSAGE_STRUCTURED_PRESENTATION_V1_MAX_DEPTH) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['snapshot'],
      message: `Structured presentation exceeds depth ${MESSAGE_STRUCTURED_PRESENTATION_V1_MAX_DEPTH}.`,
    });
  }
  for (const path of inspected.unqualifiedActionPaths) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['snapshot', ...path],
      message: 'Persisted structured-presentation Actions must use qualified plugin references.',
    });
  }
  if (textEncoder.encode(JSON.stringify(value)).byteLength > MESSAGE_STRUCTURED_PRESENTATION_V1_MAX_ENCODED_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Structured presentation exceeds ${MESSAGE_STRUCTURED_PRESENTATION_V1_MAX_ENCODED_BYTES} encoded bytes.`,
    });
  }
});
export type MessageStructuredPresentationV1 = z.infer<typeof MessageStructuredPresentationV1Schema>;

function qualifyLocalActionReferences(
  value: unknown,
  owner: MessageStructuredPresentationOwnerV1,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => qualifyLocalActionReferences(entry, owner));
  }
  if (!isRecord(value)) return value;

  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    next[key] = key === 'children'
      ? qualifyLocalActionReferences(entry, owner)
      : entry;
  }
  if ((next.kind === 'action' || next.kind === 'item') && typeof next.action === 'string') {
    next.action = { pluginId: owner.pluginId, localId: next.action };
  }
  return next;
}

/**
 * The plaintext-holding producer passes its already-current contribution
 * identity here. Local declarative Action ids become durable qualified ids
 * before encryption; callers cannot choose a persisted owner field.
 */
export function createMessageStructuredPresentationV1(params: Readonly<{
  owner: MessageStructuredPresentationOwnerV1;
  snapshot: unknown;
}>): MessageStructuredPresentationV1 {
  const owner = MessageStructuredPresentationOwnerV1Schema.parse(params.owner);
  return MessageStructuredPresentationV1Schema.parse({
    v: 1,
    profile: 'pluginTranscriptV1',
    owner,
    snapshot: qualifyLocalActionReferences(params.snapshot, owner),
  });
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return Object.freeze(value);
}

/**
 * Reads one decrypted/plain Message payload as an immutable historical
 * snapshot. Invalid or future profile records deliberately return no snapshot
 * so replay falls back without asking a current plugin to reinterpret bytes.
 */
export function readMessageStructuredPresentationV1(
  value: unknown,
): MessageStructuredPresentationV1 | null {
  try {
    const parsed = MessageStructuredPresentationV1Schema.safeParse(value);
    return parsed.success ? deepFreeze(parsed.data) : null;
  } catch {
    // The canonical declarative grammar is recursive. Persisted corruption can
    // exhaust the JavaScript stack before its owner-level depth refinement
    // runs; replay must convert that untrusted record into the losing path,
    // not reject its containing transcript page.
    return null;
  }
}

/**
 * A `profile` member is reserved for structured-presentation content. Writers
 * use this discriminator before the exact V1 parser so an unsupported profile
 * or version cannot be silently reinterpreted as ordinary Message content.
 * Readers remain schema-based and therefore render an unavailable fallback for
 * unsupported historical values instead of treating them as current V1.
 */
export function isMessageStructuredPresentationV1Candidate(value: unknown): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'profile');
}
