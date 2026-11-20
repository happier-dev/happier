import { z } from '../zodRuntimePolicy.js';
import { listVoiceActionBlockSpecs, resolveVoiceClientToolNameAlias } from '../actions/actionSpecs.js';
import { resolveActionCatalogSurfaceProjection } from '../actions/actionCatalog.js';
import { zodSchemaToJsonSchemaObject } from '../actions/actionInputJsonSchema.js';
import { PluginJsonValueV2Schema } from '../plugins/contributions/jsonSchema.js';
import { actionInputValidationFailure } from '../actions/executor/actionInputValidation.js';

type VoiceActionInputFailure = ReturnType<typeof actionInputValidationFailure>;

export const VOICE_ACTION_FUNCTION_NAME = 'happier_voice_action' as const;

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

let voiceActionFunctionTool: ReturnType<typeof buildVoiceActionFunctionTool> | undefined;
function buildVoiceActionFunctionTool() {
  return {
    name: VOICE_ACTION_FUNCTION_NAME,
    description: 'Execute one Happier Voice Action and use its returned result. If the user names a model for spawnSession, call resolveActionOptions for session.spawn_new at modelSelection. Use the exact selection returned, or ask for clarification. Omit modelSelection only if no model was requested.',
    // Advertise transport, not the whole catalog. searchActionSpecs/getActionSpec
    // provide the canonical sectioned schemas on demand; the decoder below
    // still validates args against the selected Action before executing it.
    inputSchema: PluginJsonValueV2Schema.parse(zodSchemaToJsonSchemaObject(z.strictObject({
      t: z.string(),
      args: z.record(z.string(), z.unknown()),
    }))),
  };
}

/** Native transport of the same published Action inputs consumed by the Voice host. */
export function getVoiceActionFunctionTool() {
  return voiceActionFunctionTool ??= buildVoiceActionFunctionTool();
}

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

function parseVoiceAssistantAction(rawAction: unknown): VoiceAssistantAction | VoiceActionInputFailure {
  const rawToolName = rawAction && typeof rawAction === 'object' && 't' in rawAction && typeof rawAction.t === 'string'
    ? rawAction.t.trim() : '';
  const toolName = resolveVoiceClientToolNameAlias(rawToolName);
  const inputSchema = toolName ? getVoiceActionSchemaByToolName().get(toolName) : undefined;
  if (!inputSchema || !toolName) {
    const parsed = VoiceAssistantActionSchema.safeParse(rawAction);
    return parsed.success ? parsed.data : actionInputValidationFailure(parsed.error);
  }

  let rawArgs = (rawAction as { args?: unknown }).args;
  // Some model providers JSON-encode the argument object inside the host call.
  // Decode only this transport value; the canonical Action schema still admits it.
  if (typeof rawArgs === 'string') {
    try { rawArgs = JSON.parse(rawArgs) as unknown; } catch { /* Keep the normal content-free validation failure. */ }
  }
  const direct = inputSchema.safeParse(rawArgs);
  if (direct.success) {
    return { t: toolName, args: direct.data };
  }

  const coercedArgs = coerceVoiceActionValueForSchema(rawArgs, inputSchema);
  const coerced = inputSchema.safeParse(coercedArgs);
  if (!coerced.success) return actionInputValidationFailure(coerced.error);
  return { t: toolName, args: coerced.data };
}

// This pre-execution refusal belongs here: no executable Action exists for the
// client tool-result presenter. Validator diagnostics never become speech.
const INVALID_VOICE_ACTION_MESSAGE = "I couldn't run that action because its request was invalid. Please try again.";

/** Decode structured requests at the existing Voice Action boundary, independent of transport. */
export function decodeVoiceAssistantActions(
  rawActions: readonly unknown[],
  assistantText = '',
  priorFailure?: VoiceActionInputFailure,
): Readonly<{ assistantText: string; actions: VoiceAssistantAction[]; invalidActionBlock?: true; failure?: VoiceActionInputFailure }> {
  const parsed = rawActions.map(parseVoiceAssistantAction);
  const actions = parsed.filter((entry): entry is VoiceAssistantAction => !('ok' in entry));
  const failure = parsed.find((entry): entry is VoiceActionInputFailure => 'ok' in entry)
    ?? (actions.length === 0 ? priorFailure : undefined);
  // Preserve the existing all-or-nothing request decoding.
  if (failure) {
    return {
      assistantText: INVALID_VOICE_ACTION_MESSAGE,
      actions: [],
      invalidActionBlock: true,
      failure,
    };
  }
  return { assistantText: assistantText.trim(), actions };
}
