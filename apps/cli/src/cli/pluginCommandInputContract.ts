import { type ActionInputHints, type JsonSchemaObject } from '@happier-dev/protocol';
import { compileActionCliFieldsFromJsonSchema, type ActionCliField } from '@/cli/actions/fieldCompiler';
import { type ActionCliFlagCollision, validateActionCliFlagCollisions } from '@/cli/actions/fieldFlags';

/** Already-normalized input fields, not an executable contribution registry. */
export type PluginCommandActionInputRegistry = Readonly<{
  actions?: readonly Readonly<{ pluginId?: string; definition: Readonly<{ id: string; inputSchema?: unknown; inputHints?: unknown }> }>[];
}>;

/** `--input` remains an accepted spelling of whole-input JSON for installed callers. */
export const PLUGIN_COMMAND_INPUT_JSON_ALIASES: readonly string[] = Object.freeze(['--input', '--input-json']);

export type PluginCommandActionInputContract = Readonly<{
  fields: readonly ActionCliField[];
  inputSchema: JsonSchemaObject;
  flagCollision: ActionCliFlagCollision | null;
}>;

/** Translate only the plugin command's retained whole-input alias and host flag. */
export function normalizePluginCommandActionInputTokens(tokens: readonly string[]): readonly string[] {
  let positionalOnly = false;
  return Object.freeze(tokens.flatMap((token) => {
    if (positionalOnly) return [token];
    if (token === '--') {
      positionalOnly = true;
      return [token];
    }
    if (token === '--json') return [];
    if (token === '--input') return ['--input-json'];
    if (token.startsWith('--input=')) return [`--input-json=${token.slice('--input='.length)}`];
    return [token];
  }));
}

export function readActionInputJsonSchema(definition: Readonly<Record<string, unknown>>): JsonSchemaObject | null {
  const schema = definition.inputSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  return schema as JsonSchemaObject;
}

export function readActionInputHints(definition: Readonly<Record<string, unknown>>): ActionInputHints | undefined {
  const hints = definition.inputHints;
  if (!hints || typeof hints !== 'object' || Array.isArray(hints)) return undefined;
  return hints as ActionInputHints;
}

/**
 * The canonical Action input contract used by parsing and final validation.
 * `null` means the Action has no discoverable authored input schema.
 */
export function resolvePluginCommandActionInputContract(params: Readonly<{
  registry: PluginCommandActionInputRegistry | undefined;
  qualifiedActionId: string;
}>): PluginCommandActionInputContract | null {
  const contribution = (params.registry?.actions ?? []).find((candidate) => (
    candidate.pluginId
    && `${candidate.pluginId}/${candidate.definition.id}` === params.qualifiedActionId
  ));
  if (!contribution) return null;
  const definition = contribution.definition as unknown as Readonly<Record<string, unknown>>;
  const jsonSchema = readActionInputJsonSchema(definition);
  if (!jsonSchema) return null;
  const fields = compileActionCliFieldsFromJsonSchema({
    jsonSchema,
    hints: readActionInputHints(definition),
    reservedFlags: PLUGIN_COMMAND_INPUT_JSON_ALIASES,
  });
  const flagValidation = validateActionCliFlagCollisions(
    { fields, positionals: [] },
    { reservedFlags: PLUGIN_COMMAND_INPUT_JSON_ALIASES },
  );
  return Object.freeze({
    fields,
    inputSchema: jsonSchema,
    flagCollision: flagValidation.ok ? null : flagValidation,
  });
}

