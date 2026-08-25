import { z } from 'zod';

import type { JsonValue } from '../../json/strictJsonValue.js';
import { AgentRuntimeJsonValueV1Schema } from '../../runtime/agentSessionV1.js';
import { resolveTranscriptBodySemanticEvent } from './sessionMessageRole.js';

function snapshotStructuralDto(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  context: z.RefinementCtx,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
    context.addIssue({ code: 'custom', message: 'External Session DTO contains an unknown field' });
    return z.NEVER;
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  try {
    for (const key of allowedKeys) {
      const property = Reflect.get(value, key);
      if (property !== undefined) {
        Object.defineProperty(snapshot, key, {
          configurable: false,
          enumerable: true,
          writable: false,
          value: property,
        });
      }
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'External Session DTO property read failed' });
    return z.NEVER;
  }
  return Object.freeze(snapshot);
}

const USER_CONTENT_KEYS = new Set(['type', 'text']);
const RAW_RECORD_KEYS = new Set(['role', 'content']);

const AgentExternalSessionUserContentSchema = z.preprocess(
  (value, context) => snapshotStructuralDto(value, USER_CONTENT_KEYS, context),
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }).strict(),
);

const AgentExternalSessionAgentContentSchema = AgentRuntimeJsonValueV1Schema.superRefine(
  (content, context) => {
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      context.addIssue({
        code: 'custom',
        message: 'Agent External Session content must use a canonical agent wrapper',
      });
      return;
    }
    const wrapper = content as Readonly<Record<string, JsonValue>>;
    if (
      wrapper.type !== 'output'
      && wrapper.type !== 'event'
      && wrapper.type !== 'codex'
      && wrapper.type !== 'acp'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Agent External Session content must use a canonical agent wrapper',
      });
      return;
    }
    if (
      wrapper.type === 'acp'
      && (typeof wrapper.agentId !== 'string' || wrapper.agentId.trim().length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['agentId'],
        message: 'ACP External Session content requires an agentId',
      });
      return;
    }
    const semanticEvent = resolveTranscriptBodySemanticEvent({
      protocol: 'acp',
      body: content,
    });
    if (
      !semanticEvent
      || (semanticEvent.role !== 'agent' && semanticEvent.role !== 'event')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Agent External Session content is not a supported semantic event',
      });
    }
  },
);

/**
 * Producer-supplied classification for a current user transcript row. The
 * raw envelope remains the role authority; this only supplies the origin
 * fact needed by terminal follow to decide whether that row is eligible in a
 * given phase.
 */
export const ExternalSessionUserProjectionSchema = z.enum([
  'source_fact',
  'terminal_origin',
  'host_prompt_echo',
]);
export type ExternalSessionUserProjection = z.infer<typeof ExternalSessionUserProjectionSchema>;

/**
 * Current Agent-contribution admission envelope for External Session transcript
 * rows. This is deliberately stricter than `TranscriptRawRecordV1Schema`, which
 * remains the provenance-pinned compatibility reader for persisted transcript
 * history produced by supported older versions.
 */
export type AgentExternalSessionTranscriptRawRecord =
  | Readonly<{
      role: 'user';
      content: Readonly<{ type: 'text'; text: string }>;
    }>
  | Readonly<{
      role: 'agent';
      content: JsonValue;
    }>;

const AgentExternalSessionTranscriptRawRecordUnionSchema = z.discriminatedUnion(
  'role',
  [
    z.object({
      role: z.literal('user'),
      content: AgentExternalSessionUserContentSchema,
    }).strict(),
    z.object({
      role: z.literal('agent'),
      content: AgentExternalSessionAgentContentSchema,
    }).strict(),
  ],
);

export const AgentExternalSessionTranscriptRawRecordSchema: z.ZodType<
  AgentExternalSessionTranscriptRawRecord,
  unknown
> = z.preprocess(
  (value, context) => snapshotStructuralDto(value, RAW_RECORD_KEYS, context),
  AgentExternalSessionTranscriptRawRecordUnionSchema,
);
