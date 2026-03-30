import { z } from 'zod';
import { listVoiceActionBlockSpecs, resolveVoiceClientToolNameAlias } from './actions/actionSpecs.js';

export const VOICE_ACTIONS_BLOCK = {
  startTag: '<voice_actions>',
  endTag: '</voice_actions>',
} as const;

export type VoiceAssistantAction = Readonly<{
  t: string;
  args: unknown;
}>;

type VoiceActionSchemaEntry = Readonly<{
  toolName: string;
  inputSchema: z.ZodTypeAny;
}>;

function unwrapVoiceActionSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;

  for (;;) {
    if (current instanceof z.ZodOptional) {
      current = (current as any)._def.innerType;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = (current as any)._def.innerType;
      continue;
    }
    if (current instanceof z.ZodNullable) {
      current = (current as any)._def.innerType;
      continue;
    }
    if (current instanceof z.ZodPipe) {
      current = (current as any)._def.in;
      continue;
    }
    break;
  }

  return current;
}

function listVoiceActionSchemaEntries(): VoiceActionSchemaEntry[] {
  return listVoiceActionBlockSpecs().flatMap((spec) => {
    const toolName = spec.bindings?.voiceClientToolName;
    if (!toolName) return [];
    return [{ toolName, inputSchema: spec.inputSchema }];
  });
}

function buildVoiceAssistantActionSchema(): z.ZodType<VoiceAssistantAction> {
  // Centralized: the action block schema is derived from Action Specs.
  // Each spec that opts into surface.voice_action_block must bind a stable voiceClientToolName and inputSchema.
  const voiceActionBlockOptions = listVoiceActionSchemaEntries().map(({ toolName, inputSchema }) => {
    return [
      z.object({
        t: z.literal(toolName),
        args: inputSchema,
      }),
    ];
  });

  return z.discriminatedUnion('t', voiceActionBlockOptions.flat() as any) as z.ZodType<VoiceAssistantAction>;
}

let memoizedVoiceAssistantActionSchema: z.ZodType<VoiceAssistantAction> | undefined;
function getVoiceAssistantActionSchema(): z.ZodType<VoiceAssistantAction> {
  if (!memoizedVoiceAssistantActionSchema) {
    memoizedVoiceAssistantActionSchema = buildVoiceAssistantActionSchema();
  }
  return memoizedVoiceAssistantActionSchema;
}

export const VoiceAssistantActionSchema: z.ZodType<VoiceAssistantAction> = z.lazy(() => getVoiceAssistantActionSchema());

let memoizedVoiceActionSchemaByToolName: ReadonlyMap<string, z.ZodTypeAny> | undefined;
function getVoiceActionSchemaByToolName(): ReadonlyMap<string, z.ZodTypeAny> {
  if (!memoizedVoiceActionSchemaByToolName) {
    memoizedVoiceActionSchemaByToolName = new Map(
      listVoiceActionSchemaEntries().map(({ toolName, inputSchema }) => [toolName, inputSchema]),
    );
  }
  return memoizedVoiceActionSchemaByToolName;
}

function coerceVoiceActionScalarStrings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => coerceVoiceActionScalarStrings(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, coerceVoiceActionScalarStrings(entry)]),
    );
  }
  if (typeof value !== 'string') return value;

  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    const parsedNumber = Number(value);
    if (Number.isFinite(parsedNumber)) return parsedNumber;
  }
  return value;
}

function splitVoiceActionListString(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function coerceVoiceActionValueForSchema(value: unknown, schema: z.ZodTypeAny): unknown {
  const core = unwrapVoiceActionSchema(schema);

  if (core instanceof z.ZodObject) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return coerceVoiceActionScalarStrings(value);
    }
    const shape = (core as any).shape ?? (core as any)._def?.shape ?? {};
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const fieldSchema = shape?.[key] as z.ZodTypeAny | undefined;
        return [key, fieldSchema ? coerceVoiceActionValueForSchema(entry, fieldSchema) : coerceVoiceActionScalarStrings(entry)];
      }),
    );
  }

  if (core instanceof z.ZodArray) {
    const elementSchema = (core as any)._def?.element as z.ZodTypeAny | undefined;
    const items = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? splitVoiceActionListString(value)
        : null;
    if (!items) return coerceVoiceActionScalarStrings(value);
    return items.map((entry) => (elementSchema ? coerceVoiceActionValueForSchema(entry, elementSchema) : coerceVoiceActionScalarStrings(entry)));
  }

  if (core instanceof z.ZodUnion || core instanceof z.ZodDiscriminatedUnion) {
    const options: z.ZodTypeAny[] = Array.isArray((core as any)._def?.options)
      ? ((core as any)._def.options as z.ZodTypeAny[])
      : core instanceof z.ZodDiscriminatedUnion && (core as any).options instanceof Map
        ? (Array.from((core as any).options.values()) as z.ZodTypeAny[])
        : [];
    for (const option of options) {
      const candidate = coerceVoiceActionValueForSchema(value, option);
      if (option.safeParse(candidate).success) return candidate;
    }
  }

  return coerceVoiceActionScalarStrings(value);
}

function parseVoiceAssistantAction(rawAction: unknown): VoiceAssistantAction | null {
  if (!rawAction || typeof rawAction !== 'object') return null;

  const rawToolName = typeof (rawAction as { t?: unknown }).t === 'string' ? (rawAction as { t: string }).t.trim() : '';
  if (rawToolName.length === 0) return null;

  const toolName = resolveVoiceClientToolNameAlias(rawToolName);
  if (!toolName) return null;
  const inputSchema = getVoiceActionSchemaByToolName().get(toolName);
  if (!inputSchema) return null;

  const rawArgs = (rawAction as { args?: unknown }).args;
  const direct = inputSchema.safeParse(rawArgs);
  if (direct.success) {
    return { t: toolName, args: direct.data };
  }

  const coercedArgs = coerceVoiceActionValueForSchema(rawArgs, inputSchema);
  const coerced = inputSchema.safeParse(coercedArgs);
  if (!coerced.success) return null;
  return { t: toolName, args: coerced.data };
}

export function extractVoiceActionsFromAssistantText(
  assistantTextRaw: string,
): Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }> {
  const assistantText = String(assistantTextRaw ?? '');

  const startIndex = assistantText.lastIndexOf(VOICE_ACTIONS_BLOCK.startTag);
  if (startIndex < 0) return { assistantText: assistantText.trim(), actions: [] };

  const endIndex = assistantText.indexOf(VOICE_ACTIONS_BLOCK.endTag, startIndex);
  if (endIndex < 0) return { assistantText: assistantText.trim(), actions: [] };

  const jsonRaw = assistantText
    .slice(startIndex + VOICE_ACTIONS_BLOCK.startTag.length, endIndex)
    .trim();

  try {
    const parsedJson = JSON.parse(jsonRaw) as unknown;
    if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
      return { assistantText: assistantText.trim(), actions: [] };
    }

    const rawActionsValue = (parsedJson as { actions?: unknown }).actions;
    if (rawActionsValue !== undefined && !Array.isArray(rawActionsValue)) {
      return { assistantText: assistantText.trim(), actions: [] };
    }

    const rawActions = Array.isArray(rawActionsValue) ? rawActionsValue : [];
    const actions = rawActions
      .map((rawAction) => parseVoiceAssistantAction(rawAction))
      .filter((action): action is VoiceAssistantAction => action !== null);

    if (rawActions.length > 0 && actions.length === 0) {
      return { assistantText: assistantText.trim(), actions: [] };
    }

    const stripped = `${assistantText.slice(0, startIndex)}${assistantText.slice(endIndex + VOICE_ACTIONS_BLOCK.endTag.length)}`;
    return { assistantText: stripped.trim(), actions };
  } catch {
    return { assistantText: assistantText.trim(), actions: [] };
  }
}
