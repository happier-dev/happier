import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { StrictJsonValueSchema, type JsonValue } from '../../json/strictJsonValue.js';
import { resolveTranscriptBodySemanticEvent } from './sessionMessageRole.js';

function snapshotStructuralDto(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  context: z.core.ParsePayload<unknown>,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
    context.issues.push({ code: 'custom', input: context.value, message: 'External Session DTO contains an unknown field' });
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
    context.issues.push({ code: 'custom', input: context.value, message: 'External Session DTO property read failed' });
    return z.NEVER;
  }
  return Object.freeze(snapshot);
}

const USER_CONTENT_KEYS = new Set(['type', 'text']);
const RAW_RECORD_KEYS = new Set(['role', 'content', 'media']);

// Transient source bytes only. Session media staging/adoption consumes these
// standard ACP blocks before any durable transcript write. No path authority.
const ImportedImageSchema = lazyZodSchema(() => z.strictObject({
  type: z.literal('image'),
  mimeType: z.string(),
  data: z.string(),
}));
type ImportedImage = z.infer<typeof ImportedImageSchema>;

const AgentExternalSessionUserContentSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value, context) => snapshotStructuralDto(value, USER_CONTENT_KEYS, context)), z.strictObject({
    type: z.literal('text'),
    text: z.string(),
  })));

const AgentExternalSessionAgentContentSchema = lazyZodSchema(() => StrictJsonValueSchema.check(z.superRefine((content, context) => {
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
  })));

/**
 * Producer-supplied classification for a current user transcript row. The
 * raw envelope remains the role authority; this only supplies the origin
 * fact needed by terminal follow to decide whether that row is eligible in a
 * given phase.
 */
export const ExternalSessionUserProjectionSchema = lazyZodSchema(() => z.enum([
  'source_fact',
  'terminal_origin',
  'host_prompt_echo',
]));
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
      media?: readonly ImportedImage[];
    }>
  | Readonly<{
      role: 'agent';
      content: JsonValue;
      media?: readonly ImportedImage[];
    }>;

const AgentExternalSessionTranscriptRawRecordUnionSchema = lazyZodSchema(() => z.discriminatedUnion(
  'role',
  [
    z.strictObject({
      role: z.literal('user'),
      content: AgentExternalSessionUserContentSchema,
      media: z.optional(z.array(ImportedImageSchema)),
    }),
    z.strictObject({
      role: z.literal('agent'),
      content: AgentExternalSessionAgentContentSchema,
      media: z.optional(z.array(ImportedImageSchema)),
    }),
  ],
));

export const AgentExternalSessionTranscriptRawRecordSchema: z.ZodMiniType<
  AgentExternalSessionTranscriptRawRecord,
  unknown
> = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value, context) => snapshotStructuralDto(value, RAW_RECORD_KEYS, context)), AgentExternalSessionTranscriptRawRecordUnionSchema));
