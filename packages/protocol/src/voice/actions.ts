import { z } from 'zod/mini';
import { listVoiceActionBlockSpecs, resolveVoiceClientToolNameAlias } from '../actions/actionSpecs.js';
import { projectActionInputIssues } from '../actions/executor/actionInputValidation.js';
import { resolveActionCatalogSurfaceProjection } from '../actions/actionCatalog.js';

export const VOICE_ACTIONS_TAG = 'voice_actions' as const;

export const VOICE_ACTIONS_BLOCK = {
  startTag: `<${VOICE_ACTIONS_TAG}>`,
  endTag: `</${VOICE_ACTIONS_TAG}>`,
} as const;

export type VoiceAssistantAction = Readonly<{
  t: string;
  args: unknown;
}>;

type VoiceActionSchemaEntry = Readonly<{
  toolName: string;
  inputSchema: z.ZodMiniType;
}>;

function unwrapVoiceActionSchema(schema: z.core.$ZodType): z.core.$ZodType {
  let current = schema;

  for (;;) {
    if (current instanceof z.ZodMiniOptional) {
      current = current._zod.def.innerType;
      continue;
    }
    if (current instanceof z.ZodMiniDefault) {
      current = current._zod.def.innerType;
      continue;
    }
    if (current instanceof z.ZodMiniNullable) {
      current = current._zod.def.innerType;
      continue;
    }
    if (current instanceof z.ZodMiniPipe) {
      current = current._zod.def.in;
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
    return [{ toolName, inputSchema: resolveActionCatalogSurfaceProjection(spec, 'voice').inputSchema }];
  });
}

function buildVoiceAssistantActionSchema(): z.ZodMiniType<VoiceAssistantAction> {
  // Centralized: the action block schema is derived from Action Specs.
  // Each spec that opts into the voice surface must bind a stable voiceClientToolName and inputSchema.
  const voiceActionBlockOptions = listVoiceActionSchemaEntries().map(({ toolName, inputSchema }) => {
    return [
      z.object({
        t: z.literal(toolName),
        args: inputSchema,
      }),
    ];
  });

  const options = voiceActionBlockOptions.flat();
  return z.discriminatedUnion('t', options as [typeof options[number], ...typeof options[number][]]) as z.ZodMiniType<VoiceAssistantAction>;
}

let memoizedVoiceAssistantActionSchema: z.ZodMiniType<VoiceAssistantAction> | undefined;
function getVoiceAssistantActionSchema(): z.ZodMiniType<VoiceAssistantAction> {
  if (!memoizedVoiceAssistantActionSchema) {
    memoizedVoiceAssistantActionSchema = buildVoiceAssistantActionSchema();
  }
  return memoizedVoiceAssistantActionSchema;
}

export const VoiceAssistantActionSchema: z.ZodMiniType<VoiceAssistantAction> = z.lazy(() => getVoiceAssistantActionSchema());

let memoizedVoiceActionSchemaByToolName: ReadonlyMap<string, z.ZodMiniType> | undefined;
function getVoiceActionSchemaByToolName(): ReadonlyMap<string, z.ZodMiniType> {
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

function coerceVoiceActionValueForSchema(value: unknown, schema: z.core.$ZodType): unknown {
  const core = unwrapVoiceActionSchema(schema);

  if (core instanceof z.ZodMiniObject) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return coerceVoiceActionScalarStrings(value);
    }
    const shape = core.shape;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const fieldSchema = shape[key];
        return [key, fieldSchema ? coerceVoiceActionValueForSchema(entry, fieldSchema) : coerceVoiceActionScalarStrings(entry)];
      }),
    );
  }

  if (core instanceof z.ZodMiniArray) {
    const elementSchema = core._zod.def.element;
    const items = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? splitVoiceActionListString(value)
        : null;
    if (!items) return coerceVoiceActionScalarStrings(value);
    return items.map((entry) => coerceVoiceActionValueForSchema(entry, elementSchema));
  }

  if (core instanceof z.ZodMiniUnion || core instanceof z.ZodMiniDiscriminatedUnion) {
    const options = core._zod.def.options;
    for (const option of options) {
      const candidate = coerceVoiceActionValueForSchema(value, option);
      if (z.safeParse(option, candidate).success) return candidate;
    }
  }

  return coerceVoiceActionScalarStrings(value);
}

function parseVoiceAssistantAction(rawAction: unknown): { action: VoiceAssistantAction } | { invalidInput: string } | null {
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
    return { action: { t: toolName, args: direct.data } };
  }

  const coercedArgs = coerceVoiceActionValueForSchema(rawArgs, inputSchema);
  const coerced = inputSchema.safeParse(coercedArgs);
  if (!coerced.success) {
    const fields = [...new Set(projectActionInputIssues(coerced.error)
      .map((issue) => `${issue.path.join('.') || 'args'} (${issue.message ?? issue.code})`))];
    return { invalidInput: `${toolName}: ${fields.join(', ')}.` };
  }
  return { action: { t: toolName, args: coerced.data } };
}

export function extractVoiceActionsFromAssistantText(
  assistantTextRaw: string,
): Readonly<{ assistantText: string; actions: VoiceAssistantAction[]; invalidActionBlock?: true }> {
  const assistantText = String(assistantTextRaw ?? '');

  const startIndex = assistantText.indexOf(VOICE_ACTIONS_BLOCK.startTag);
  if (startIndex < 0) return { assistantText: assistantText.trim(), actions: [] };

  // An attempted action that cannot execute must not settle as ordinary prose:
  // otherwise "Creating ... now" survives while its mutation silently vanishes.
  const invalidActionBlock = {
    assistantText: "I couldn't run that action because its request was invalid. Please try again.",
    actions: [],
    invalidActionBlock: true as const,
  };
  const endIndex = assistantText.indexOf(VOICE_ACTIONS_BLOCK.endTag, startIndex);
  const stripped = endIndex < 0
    ? assistantText.slice(0, startIndex)
    : `${assistantText.slice(0, startIndex)}${assistantText.slice(endIndex + VOICE_ACTIONS_BLOCK.endTag.length)}`;
  if (endIndex < 0) return invalidActionBlock;

  const jsonRaw = assistantText
    .slice(startIndex + VOICE_ACTIONS_BLOCK.startTag.length, endIndex)
    .trim();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonRaw);
  } catch {
    // Native SyntaxError prose can quote rejected content. Name the syntax
    // failure without copying its message, payload or a guessed invalid field.
    return { ...invalidActionBlock, assistantText: "I couldn't run that action because its action block contained invalid JSON. No action ran." };
  }
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    return invalidActionBlock;
  }

  const rawActionsValue = (parsedJson as { actions?: unknown }).actions;
  if (rawActionsValue !== undefined && !Array.isArray(rawActionsValue)) {
    return invalidActionBlock;
  }

  const rawActions = Array.isArray(rawActionsValue) ? rawActionsValue : [];
  const parsedActions = rawActions.map(parseVoiceAssistantAction);
  const actions = parsedActions.flatMap((parsed) => parsed && 'action' in parsed ? [parsed.action] : []);

  // Reject the block together: executing a valid subset would silently omit
  // requested work while preserving narration that says it all succeeded.
  if (actions.length !== rawActions.length) {
    const invalidInputs = parsedActions.flatMap((parsed) => parsed && 'invalidInput' in parsed ? [parsed.invalidInput] : []);
    return invalidInputs.length > 0
      ? { ...invalidActionBlock, assistantText: `I couldn't run that action because its input was invalid. ${invalidInputs.join(' ')}` }
      : invalidActionBlock;
  }

  return { assistantText: stripped.trim(), actions };
}
