import {
  findCompiledActionCliCommand,
  listCompiledActionCliCommands,
  type ActionCliField,
  type CompiledActionCliCommand,
} from './compiledCommands';
import {
  ACTION_CLI_HELP_FLAGS,
  ACTION_CLI_JSON_OUTPUT_FLAG,
  ACTION_CLI_SERVER_ID_FLAG,
  ACTION_CLI_WHOLE_INPUT_FLAG,
  parseActionCliInput,
  resolveActionCliFieldState,
  stripCliOwnedFlags,
  type ActionCliParseTarget,
} from './parseCommandInput';

export type ActionCliCompletionContext = Readonly<{
  /** Already typed words, excluding the partial one being completed. */
  committed: readonly string[];
  prefix: string;
  commands?: readonly CompiledActionCliCommand[];
}>;

export type ActionCliDynamicOptionsRequest = Readonly<{
  /** Built-in or plugin-qualified Action id. */
  actionId: string;
  fieldPath: string;
  optionsSourceId: string;
  draftInput: Readonly<Record<string, unknown>>;
  query: string;
  /** Committed Action argv, including CLI-owned routing flags. */
  committedArgv: readonly string[];
  /** Whether `--server-id` is transport syntax for this exact command. */
  acceptsServerId: boolean;
}>;

export type ActionCliDynamicOptionsResolver = (
  request: ActionCliDynamicOptionsRequest,
) => Promise<readonly string[]>;

type ActionCliOwnedFlagPolicy = Readonly<{
  booleanFlags?: readonly string[];
  valueFlags?: readonly string[];
}>;

function fieldForValuePosition(
  command: ActionCliParseTarget,
  committed: readonly string[],
): ActionCliField | null {
  const previous = committed.at(-1);
  if (typeof previous !== 'string' || !previous.startsWith('--')) return null;
  return command.fields.find((field) => (
    field.kind !== 'boolean'
    && field.kind !== 'json'
    && (field.flag === previous || field.aliases.includes(previous))
  )) ?? null;
}

function inlineValueCompletion(
  command: ActionCliParseTarget,
  prefix: string,
): Readonly<{ field: ActionCliField; query: string; decorate: (value: string) => string }> | null {
  const equalsAt = prefix.indexOf('=');
  if (equalsAt < 0) return null;
  const spelling = prefix.slice(0, equalsAt);
  const field = command.fields.find((candidate) => (
    candidate.kind !== 'boolean'
    && candidate.kind !== 'json'
    && (candidate.flag === spelling || candidate.aliases.includes(spelling))
  ));
  if (!field) return null;
  const query = prefix.slice(equalsAt + 1);
  return { field, query, decorate: (value) => `${spelling}=${value}` };
}

function fieldValueCompletion(
  field: ActionCliField,
  rawQuery: string,
  outerDecorate: (value: string) => string,
): Readonly<{ query: string; decorate: (value: string) => string }> {
  const separator = field.listSeparator === 'comma'
    ? ','
    : field.listSeparator === 'newline'
      ? '\n'
      : null;
  const separatorAt = separator === null ? -1 : rawQuery.lastIndexOf(separator);
  const separatorLength = separator?.length ?? 0;
  const completedPrefix = separatorAt < 0 ? '' : rawQuery.slice(0, separatorAt + separatorLength);
  return Object.freeze({
    query: separatorAt < 0 ? rawQuery : rawQuery.slice(separatorAt + separatorLength),
    decorate: (value: string) => outerDecorate(`${completedPrefix}${value}`),
  });
}

function acceptedSpellings(field: ActionCliField): readonly string[] {
  if (field.kind === 'boolean') {
    return [field.flag, ...field.aliases, `--no-${field.flag.slice(2)}`];
  }
  return field.kind === 'json'
    ? [`${field.flag}-json`, ...field.aliases]
    : [field.flag, ...field.aliases, `${field.flag}-json`];
}

function usedFlags(
  command: ActionCliParseTarget,
  committed: readonly string[],
  draftInput: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  const used = new Set<string>();
  const committedFlagNames = new Set<string>();
  for (const token of committed) {
    if (!token.startsWith('--')) continue;
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    committedFlagNames.add(name);
    const field = command.fields.find((candidate) => (
      acceptedSpellings(candidate).includes(name)
    ));
    // A repeated list flag stays available only when the list came from its
    // repeatable scalar spelling. The field-JSON spelling is a complete source
    // and cannot be combined with another spelling at execution.
    if (field && (field.kind !== 'string_list' || name === `${field.flag}-json`)) {
      for (const spelling of acceptedSpellings(field)) used.add(spelling);
    }
  }
  // A field already supplied positionally or by whole-input JSON is a source
  // the parser will refuse to combine with its flag, so its flag is not offered.
  // Only a list collected through its own repeatable spelling stays open.
  for (const field of command.fields) {
    if (!resolveActionCliFieldState(field, draftInput).present) continue;
    if (
      field.kind === 'string_list'
      && [field.flag, ...field.aliases].some((spelling) => committedFlagNames.has(spelling))
    ) continue;
    for (const spelling of acceptedSpellings(field)) used.add(spelling);
  }
  for (const field of command.fields) {
    if (field.maxSelections === null) continue;
    if (resolveActionCliFieldState(field, draftInput).selectionCount < field.maxSelections) continue;
    for (const spelling of acceptedSpellings(field)) used.add(spelling);
  }
  return used;
}

function readDraftInput(
  target: ActionCliParseTarget,
  committed: readonly string[],
): Readonly<Record<string, unknown>> {
  const parsed = parseActionCliInput(target, committed, { validateHints: false });
  return parsed.ok
    ? Object.freeze({ ...(parsed.canonicalBase ?? {}), ...parsed.callerOverlay })
    : Object.freeze({});
}

/**
 * Completion for the Action-input part of either a bundled friendly command or
 * a contributed command. `committed` starts after the command path. Keeping
 * this path-agnostic lets both callers share flag/alias/enum semantics without
 * creating another command registry.
 */
export function resolveActionCliInputCompletionCandidates(params: Readonly<{
  target: ActionCliParseTarget;
  committed: readonly string[];
  prefix: string;
}>): readonly string[] {
  if (params.committed.includes('--')) return Object.freeze([]);

  const candidates = new Set<string>();
  const inline = inlineValueCompletion(params.target, params.prefix);
  const valueField = inline?.field ?? fieldForValuePosition(params.target, params.committed);
  const draftInput = readDraftInput(
    params.target,
    inline || !valueField ? params.committed : params.committed.slice(0, -1),
  );
  if (valueField) {
    const state = resolveActionCliFieldState(valueField, draftInput);
    if (!state.visible || state.disabled || (
      valueField.maxSelections !== null && state.selectionCount >= valueField.maxSelections
    )) return Object.freeze([]);
    const completion = fieldValueCompletion(
      valueField,
      inline?.query ?? params.prefix,
      inline?.decorate ?? ((value) => value),
    );
    for (const choice of valueField.choices ?? []) {
      if (choice.startsWith(completion.query)) candidates.add(completion.decorate(choice));
    }
    return Object.freeze([...candidates].sort());
  }

  if (params.prefix === '' || params.prefix.startsWith('-')) {
    const used = usedFlags(params.target, params.committed, draftInput);
    for (const field of params.target.fields) {
      const state = resolveActionCliFieldState(field, draftInput);
      if (!state.visible || state.disabled) continue;
      for (const flag of acceptedSpellings(field)) {
        if (!used.has(flag) && flag.startsWith(params.prefix)) candidates.add(flag);
      }
    }
    for (const flag of [ACTION_CLI_WHOLE_INPUT_FLAG, ACTION_CLI_JSON_OUTPUT_FLAG, ACTION_CLI_HELP_FLAGS[0]]) {
      if (!used.has(flag) && flag.startsWith(params.prefix)) candidates.add(flag);
    }
  }
  return Object.freeze([...candidates].sort());
}

/**
 * Dynamic extension of the path-agnostic Action-input completion owner. Both a
 * compiled built-in command and a contributed plugin command supply their
 * already-qualified Action id and the same compiled field target; this helper
 * alone derives the options request and draft input.
 */
export async function resolveActionCliInputCompletionCandidatesWithDynamicOptions(params: Readonly<{
  target: ActionCliParseTarget;
  actionId: string;
  committed: readonly string[];
  prefix: string;
  resolveDynamicOptions: ActionCliDynamicOptionsResolver;
  cliOwnedFlags?: ActionCliOwnedFlagPolicy;
}>): Promise<readonly string[]> {
  const candidates = new Set(resolveActionCliInputCompletionCandidates(params));
  if (params.committed.includes('--')) return Object.freeze([...candidates].sort());

  const inline = inlineValueCompletion(params.target, params.prefix);
  const field = inline?.field ?? fieldForValuePosition(params.target, params.committed);
  if (!field?.optionsSourceId) return Object.freeze([...candidates].sort());
  const draftTokens = stripCliOwnedFlags(
    inline ? params.committed : params.committed.slice(0, -1),
    params.cliOwnedFlags ?? {},
  );
  const draft = parseActionCliInput(params.target, draftTokens, { validateHints: false });
  const draftInput = draft.ok
    ? Object.freeze({ ...(draft.canonicalBase ?? {}), ...draft.callerOverlay })
    : Object.freeze({});
  const fieldState = resolveActionCliFieldState(field, draftInput);
  if (!fieldState.visible || fieldState.disabled || (
    field.maxSelections !== null && fieldState.selectionCount >= field.maxSelections
  )) return Object.freeze([...candidates].sort());
  const completion = fieldValueCompletion(
    field,
    inline?.query ?? params.prefix,
    inline?.decorate ?? ((value) => value),
  );
  for (const value of await params.resolveDynamicOptions({
    actionId: params.actionId,
    fieldPath: field.path,
    optionsSourceId: field.optionsSourceId,
    draftInput,
    query: completion.query,
    committedArgv: params.committed,
    acceptsServerId: Boolean(params.cliOwnedFlags?.valueFlags?.includes(ACTION_CLI_SERVER_ID_FLAG)),
  })) {
    if (value.startsWith(completion.query)) candidates.add(completion.decorate(value));
  }
  return Object.freeze([...candidates].sort());
}

/**
 * Completion for compiled Action commands: next path segment, then the flags and
 * static choices of the exact command. Static enum values need no credentials;
 * the async entry below composes dynamic `optionsSourceId` values through an
 * injected canonical Action resolver without teaching this compiler the source.
 */
export function resolveCompiledActionCliCompletionCandidates(
  context: ActionCliCompletionContext,
): readonly string[] {
  const commands = context.commands ?? listCompiledActionCliCommands();
  const candidates = new Set<string>();

  for (const command of commands) {
    if (command.visibility === 'hidden') continue;
    if (!context.committed.every((segment, index) => command.path[index] === segment)) continue;
    const next = command.path[context.committed.length];
    if (next?.startsWith(context.prefix)) candidates.add(next);
  }

  const exact = findCompiledActionCliCommand(context.committed, commands);
  if (exact && exact.path.length <= context.committed.length) {
    const inputWords = context.committed.slice(exact.path.length);
    for (const candidate of resolveActionCliInputCompletionCandidates({
      target: exact,
      committed: inputWords,
      prefix: context.prefix,
    })) {
      candidates.add(candidate);
    }
    // Transport flags are options, not values. Suppress them while completing
    // the value of an Action field just as the shared input helper suppresses
    // every ordinary flag in that position.
    if (!inputWords.includes('--') && !fieldForValuePosition(exact, inputWords)) {
      for (const flag of exact.transportMachineIdFlags) {
        if (flag.startsWith(context.prefix)) candidates.add(flag);
      }
      if (exact.acceptsServerId && ACTION_CLI_SERVER_ID_FLAG.startsWith(context.prefix)) {
        candidates.add(ACTION_CLI_SERVER_ID_FLAG);
      }
    }
  }

  return Object.freeze([...candidates].sort());
}

/**
 * Async extension for the real completion entry point. The compiler continues
 * to own argv interpretation while the injected resolver calls the canonical
 * `action.options.resolve` Action; no option-source registry is recreated here.
 * Failure policy stays with the caller, which can preserve static completion.
 */
export async function resolveCompiledActionCliCompletionCandidatesWithDynamicOptions(
  context: ActionCliCompletionContext & Readonly<{
    resolveDynamicOptions: ActionCliDynamicOptionsResolver;
  }>,
): Promise<readonly string[]> {
  const candidates = new Set(resolveCompiledActionCliCompletionCandidates(context));
  if (context.committed.includes('--')) return Object.freeze([...candidates].sort());

  const commands = context.commands ?? listCompiledActionCliCommands();
  const command = findCompiledActionCliCommand(context.committed, commands);
  if (!command) return Object.freeze([...candidates].sort());
  const inputWords = context.committed.slice(command.path.length);
  for (const value of await resolveActionCliInputCompletionCandidatesWithDynamicOptions({
    target: command,
    actionId: command.actionId,
    committed: inputWords,
    prefix: context.prefix,
    resolveDynamicOptions: context.resolveDynamicOptions,
    cliOwnedFlags: {
      valueFlags: [
        ...command.transportMachineIdFlags,
        ...(command.acceptsServerId ? [ACTION_CLI_SERVER_ID_FLAG] : []),
      ],
    },
  })) {
    candidates.add(value);
  }
  return Object.freeze([...candidates].sort());
}
