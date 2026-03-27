import { z } from 'zod';

import { createSessionMessageMetaSchema } from './sessionMessageMeta.js';

const UsageDataSchema = z
  .object({
    input_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    output_tokens: z.number(),
    // Some upstream providers emit `service_tier: null` in error payloads.
    // Treat null as “unknown” so we don't drop the whole message.
    service_tier: z.string().nullish(),
  })
  .passthrough();

const UsageDataBestEffortSchema = z
  .unknown()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const parsed = UsageDataSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  });

const RawTextContentSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .passthrough();

const RawToolUseContentSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  })
  .passthrough();

const RawToolResultContentSchema = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.unknown(),
    is_error: z.boolean().optional(),
    // Provider-specific; keep permissive for forward compatibility.
    permissions: z.unknown().optional(),
  })
  .passthrough();

const RawThinkingContentSchema = z
  .object({
    type: z.literal('thinking'),
    thinking: z.string(),
  })
  .passthrough();

// Forward compatibility: keep unknown content blocks instead of dropping the entire message.
// Callers can render these as a placeholder if needed.
const RawUnknownContentSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

// Hyphenated tool-call formats seen in some providers (Codex/Gemini variants).
const RawHyphenatedToolCallSchema = z
  .object({
    type: z.literal('tool-call'),
    callId: z.string(),
    id: z.string().optional(),
    name: z.string(),
    input: z.unknown(),
  })
  .passthrough();

const RawHyphenatedToolResultSchema = z
  .object({
    type: z.literal('tool-call-result'),
    callId: z.string(),
    tool_use_id: z.string().optional(),
    output: z.unknown(),
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

const RawAgentContentSchema = z.union([
  RawTextContentSchema,
  RawToolUseContentSchema,
  RawToolResultContentSchema,
  RawThinkingContentSchema,
  RawHyphenatedToolCallSchema,
  RawHyphenatedToolResultSchema,
  RawUnknownContentSchema,
]);

function normalizeToToolUse(input: z.infer<typeof RawHyphenatedToolCallSchema>) {
  return {
    ...input,
    type: 'tool_use' as const,
    id: input.callId,
  };
}

function normalizeToToolResult(input: z.infer<typeof RawHyphenatedToolResultSchema>) {
  return {
    ...input,
    type: 'tool_result' as const,
    tool_use_id: input.callId,
    content: (input as any).output ?? (input as any).content ?? '',
    is_error: input.is_error ?? false,
  };
}

function preprocessMessageContent(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;

  const normalizeContent = (item: any): any => {
    if (!item || typeof item !== 'object') return item;
    if (item.type === 'tool-call' && typeof item.callId === 'string' && item.callId.trim().length > 0) {
      return normalizeToToolUse(item);
    }
    if (item.type === 'tool-call-result' && typeof item.callId === 'string' && item.callId.trim().length > 0) {
      return normalizeToToolResult(item);
    }
    return item;
  };

  const record: any = data;
  const maybeArray = (value: unknown) => (Array.isArray(value) ? value : null);

  if (record.role === 'agent' && record.content?.type === 'output') {
    const assistantContent = maybeArray(record.content?.data?.message?.content);
    if (assistantContent) {
      record.content.data.message.content = assistantContent.map(normalizeContent);
    }

    const userContent = maybeArray(record.content?.data?.message?.content);
    if (record.content?.data?.type === 'user' && userContent) {
      record.content.data.message.content = userContent.map(normalizeContent);
    }

    // Forward compatibility: usage payloads are unstable and frequently evolve.
    // If usage doesn't match our structured schema, drop it so the record still parses.
    const usage = record.content?.data?.message?.usage;
    if (usage !== undefined) {
      const usageParsed = UsageDataSchema.safeParse(usage);
      if (!usageParsed.success) {
        try {
          delete record.content.data.message.usage;
        } catch {
          // Ignore if we can't delete (e.g. frozen object); parsing will still succeed via passthrough.
        }
      }
    }
  }

  return record;
}

const KNOWN_OUTPUT_DATA_TYPES = new Set(['system', 'result', 'summary', 'progress', 'assistant', 'user'] as const);

type UnknownOutputDataType = string & { readonly __happierUnknownOutputDataType: unique symbol };

const OutputExtrasShape = {
  isSidechain: z.boolean().nullish(),
  isCompactSummary: z.boolean().nullish(),
  isMeta: z.boolean().nullish(),
  uuid: z.string().nullish(),
  parentUuid: z.string().nullish(),
} as const;

const withOutputExtras = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
  schema.extend(OutputExtrasShape).passthrough();

const RawAgentOutputDataKnownSchema = z.discriminatedUnion('type', [
  withOutputExtras(z.object({ type: z.literal('system') })),
  withOutputExtras(z.object({ type: z.literal('result') })),
  withOutputExtras(z.object({ type: z.literal('summary'), summary: z.string() })),
  withOutputExtras(z.object({ type: z.literal('progress') })),
  withOutputExtras(
    z.object({
      type: z.literal('assistant'),
      message: z
        .object({
          role: z.literal('assistant'),
          model: z.string().optional(),
          content: z.union([z.array(RawAgentContentSchema), z.string()]),
          // Usage is best-effort: do not reject the whole message if upstream changes the usage shape.
          usage: UsageDataBestEffortSchema,
        })
        .passthrough(),
      parent_tool_use_id: z.string().nullable().optional(),
    }),
  ),
  withOutputExtras(
    z.object({
      type: z.literal('user'),
      message: z
        .object({
          role: z.literal('user'),
          content: z.union([z.string(), z.array(RawAgentContentSchema)]),
        })
        .passthrough(),
      parent_tool_use_id: z.string().nullable().optional(),
      toolUseResult: z.unknown().nullable().optional(),
    }),
  ),
]);

const RawAgentOutputDataUnknownSchema = z
  .object({ type: z.string() })
  .extend(OutputExtrasShape)
  .passthrough()
  .refine((value) => !KNOWN_OUTPUT_DATA_TYPES.has(value.type as any), {
    message: 'Unknown output type must not collide with known output types',
  })
  .transform((value) => ({ ...value, type: value.type as UnknownOutputDataType }));

const RawAgentOutputDataSchema = z.union([RawAgentOutputDataKnownSchema, RawAgentOutputDataUnknownSchema]);

const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('switch'), mode: z.enum(['local', 'remote']) }).passthrough(),
  z.object({ type: z.literal('message'), message: z.string() }).passthrough(),
  z.object({ type: z.literal('limit-reached'), endsAt: z.number() }).passthrough(),
  z
    .object({
      type: z.literal('task-lifecycle'),
      event: z.enum(['task_started', 'task_complete', 'turn_aborted']),
      id: z.string().nullable().optional(),
    })
    .passthrough(),
  z.object({ type: z.literal('ready') }).passthrough(),
]);

const RawAgentRecordSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('output'),
      data: RawAgentOutputDataSchema,
    }),
    z.object({ type: z.literal('event'), id: z.string(), data: AgentEventSchema }).passthrough(),
    z
      .object({
        type: z.literal('codex'),
        data: z
          .discriminatedUnion('type', [
            z.object({ type: z.literal('reasoning'), message: z.string(), sidechainId: z.string().optional() }),
            z.object({ type: z.literal('message'), message: z.string(), sidechainId: z.string().optional() }),
            z.object({ type: z.literal('token_count'), sidechainId: z.string().optional() }).passthrough(),
            z
              .object({
                type: z.literal('tool-call'),
                callId: z.string(),
                input: z.unknown(),
                name: z.string(),
                id: z.string(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
            z
              .object({
                type: z.literal('tool-call-result'),
                callId: z.string(),
                output: z.unknown(),
                id: z.string(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
          ])
          ,
      })
      .passthrough(),
    z
      .object({
        type: z.literal('acp'),
        provider: z.string().trim().min(1),
        data: z.lazy(() => {
          const knownTypes = new Set([
            'reasoning',
            'message',
            'thinking',
            'tool-call',
            'tool-result',
            'tool-call-result',
            'file-edit',
            'terminal-output',
            'task_started',
            'task_complete',
            'turn_aborted',
            'permission-request',
            'token_count',
          ] as const);

          const known = z.discriminatedUnion('type', [
            z.object({ type: z.literal('reasoning'), message: z.string(), sidechainId: z.string().optional() }).passthrough(),
            z.object({ type: z.literal('message'), message: z.string(), sidechainId: z.string().optional() }).passthrough(),
            z.object({ type: z.literal('thinking'), text: z.string(), sidechainId: z.string().optional() }).passthrough(),
            z
              .object({
                type: z.literal('tool-call'),
                callId: z.string(),
                input: z.unknown(),
                name: z.string(),
                id: z.string(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
            z
              .object({
                type: z.literal('tool-result'),
                callId: z.string(),
                output: z.unknown(),
                id: z.string(),
                isError: z.boolean().optional(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
            z
              .object({
                type: z.literal('tool-call-result'),
                callId: z.string(),
                output: z.unknown(),
                id: z.string(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
            z
              .object({
                type: z.literal('file-edit'),
                description: z.string(),
                filePath: z.string(),
                diff: z.string().optional(),
                oldContent: z.string().optional(),
                newContent: z.string().optional(),
                id: z.string(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
            z
              .object({
                type: z.literal('terminal-output'),
                data: z.string(),
                callId: z.string(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
            z.object({ type: z.literal('task_started'), id: z.string(), sidechainId: z.string().optional() }).passthrough(),
            z.object({ type: z.literal('task_complete'), id: z.string(), sidechainId: z.string().optional() }).passthrough(),
            z.object({ type: z.literal('turn_aborted'), id: z.string(), sidechainId: z.string().optional() }).passthrough(),
            z
              .object({
                type: z.literal('permission-request'),
                permissionId: z.string(),
                toolName: z.string(),
                description: z.string(),
                options: z.unknown().optional(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
            z.object({ type: z.literal('token_count'), sidechainId: z.string().optional() }).passthrough(),
          ]);

          const unknown = z
            .object({ type: z.string() })
            .passthrough()
            .refine((value) => !knownTypes.has(value.type as any), {
              message: 'Unknown ACP data type must not collide with known types',
            });

          return z.union([known, unknown]);
        }),
      })
      .passthrough(),
  ])
  ;

export function createTranscriptRawRecordV1Schema(
  zod: typeof z,
  options?: Readonly<{
    metaSchema?: z.ZodTypeAny;
  }>,
) {
  const metaSchema = options?.metaSchema ?? createSessionMessageMetaSchema(zod);

  return zod.preprocess(
    preprocessMessageContent,
    zod.discriminatedUnion('role', [
      zod
        .object({
          role: zod.literal('agent'),
          content: RawAgentRecordSchema,
          meta: metaSchema.optional(),
        })
        .passthrough(),
      zod
        .object({
          role: zod.literal('user'),
          content: zod
            .object({
              type: zod.literal('text'),
              text: zod.string(),
            })
            .passthrough(),
          meta: metaSchema.optional(),
        })
        .passthrough(),
    ]),
  );
}

export const TranscriptRawRecordV1Schema = createTranscriptRawRecordV1Schema(z);
export type TranscriptRawRecordV1 = z.infer<typeof TranscriptRawRecordV1Schema>;

export const TranscriptRawUsageDataV1Schema = UsageDataSchema;
export type TranscriptRawUsageDataV1 = z.infer<typeof TranscriptRawUsageDataV1Schema>;

export const TranscriptRawAgentEventV1Schema = AgentEventSchema;
export type TranscriptRawAgentEventV1 = z.infer<typeof TranscriptRawAgentEventV1Schema>;

export const TranscriptRawAgentContentV1Schema = RawAgentContentSchema;
export type TranscriptRawAgentContentV1 = z.infer<typeof TranscriptRawAgentContentV1Schema>;

export const TranscriptRawAgentRecordV1Schema = RawAgentRecordSchema;
export type TranscriptRawAgentRecordV1 = z.infer<typeof TranscriptRawAgentRecordV1Schema>;
