import { randomUUID } from 'node:crypto';

import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol';

import { assertCommandArguments, invalidCommandArguments } from '@/cli/commands/shared/argvFlags';

import { compileActionCliFields } from './compiledCommands';
import {
  ACTION_CLI_JSON_OUTPUT_FLAG,
  ACTION_CLI_WHOLE_INPUT_FLAG,
  composeActionCliInput,
  describeActionCliCommandFlags,
  parseActionCliInput,
  validateActionCliCallerFields,
  type ActionCliParseFailure,
  type ComposedActionCliInput,
} from './parseCommandInput';

/**
 * A retained workflow command (plan §10.2): its own positionals and
 * workflow-only options stay declared here, visibly separate from the Action
 * fields, while the Action portion of its input goes through the same compiled
 * field parser, caller binder and final canonical schema every friendly and
 * generic Action command uses.
 */
export type WorkflowActionCliDeclaration = Readonly<{
  actionId: ActionId;
  usage: string;
  /** argv index of the first argument after the command path. */
  startIndex: number;
  maxPositionals: number;
  workflowValueFlags?: readonly string[];
  workflowBooleanFlags?: readonly string[];
  /** Established spellings kept as aliases of Action fields. */
  fieldAliases?: readonly Readonly<{ path: string; aliases: readonly string[] }>[];
  /**
   * Action fields this workflow resolves itself from its own options — a
   * Session selector, an asynchronously resolved backend list — so they have no
   * generated flag of their own. The resolved value still enters the one
   * composition below and is refused when whole-input JSON already carries it.
   */
  workflowOwnedFields?: readonly string[];
}>;

export type WorkflowActionCliInput = Readonly<{
  positionals: readonly string[];
  /** The last value supplied for a workflow-only value option. */
  readWorkflowValue: (flag: string) => string | null;
  hasWorkflowFlag: (flag: string) => boolean;
  /** Whether whole-input JSON or an Action field flag already supplies this field. */
  supplies: (path: string) => boolean;
  /** Composes the canonical Action input once the workflow resolved its own fields. */
  compose: (resolved: Readonly<Record<string, unknown>>) => ComposedActionCliInput;
}>;

function parseFailure(message: string): ActionCliParseFailure {
  return { ok: false, code: 'invalid_arguments', message };
}

/**
 * Parses a retained workflow's argv. Unknown options, surplus positionals,
 * malformed field values and duplicate sources all fail here, synchronously,
 * before the workflow reads credentials or resolves anything.
 */
export function parseWorkflowActionCliInput(
  argv: readonly string[],
  declaration: WorkflowActionCliDeclaration,
): WorkflowActionCliInput {
  const spec = getActionSpec(declaration.actionId);
  const workflowValueFlags = new Set(declaration.workflowValueFlags ?? []);
  const workflowBooleanFlags = new Set([ACTION_CLI_JSON_OUTPUT_FLAG, ...(declaration.workflowBooleanFlags ?? [])]);
  const owned = new Set(declaration.workflowOwnedFields ?? []);
  const compiled = compileActionCliFields(spec, {
    reservedFlags: [...workflowValueFlags, ...workflowBooleanFlags],
    ...(declaration.fieldAliases ? { flagAliases: declaration.fieldAliases } : {}),
  });
  const target = { fields: compiled.fields.filter((field) => !owned.has(field.path)), positionals: [] as const };
  const actionFlags = describeActionCliCommandFlags(target);
  const actionValueFlags = new Set([ACTION_CLI_WHOLE_INPUT_FLAG, ...actionFlags.valueFlags]);
  const actionBooleanFlags = new Set(actionFlags.booleanFlags);
  assertCommandArguments(argv, {
    usage: declaration.usage,
    startIndex: declaration.startIndex,
    booleanFlags: [...workflowBooleanFlags, ...actionBooleanFlags],
    valueFlags: [...workflowValueFlags, ...actionValueFlags],
    maxPositionals: declaration.maxPositionals,
  });

  // Split one argv into the workflow's portion and the Action's portion. The
  // Action tokens keep their exact bytes for the shared parser.
  const positionals: string[] = [];
  const workflowValues = new Map<string, string>();
  const workflowFlagsSeen = new Set<string>();
  const actionTokens: string[] = [];
  let positionalOnly = false;
  for (let index = declaration.startIndex; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (positionalOnly) { positionals.push(token); continue; }
    if (token === '--') { positionalOnly = true; continue; }
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    const equalsIndex = token.indexOf('=');
    const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    if (workflowValueFlags.has(name)) {
      const value = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : argv[++index] ?? '';
      workflowValues.set(name, value);
      workflowFlagsSeen.add(name);
      continue;
    }
    if (workflowBooleanFlags.has(name)) { workflowFlagsSeen.add(name); continue; }
    actionTokens.push(token);
    if (actionValueFlags.has(name) && equalsIndex < 0) actionTokens.push(argv[++index] ?? '');
  }

  const parsed = parseActionCliInput(target, actionTokens);
  if (!parsed.ok) throw invalidCommandArguments(declaration.usage, parsed.message);
  const malformed = validateActionCliCallerFields(compiled.callerSchema, parsed.callerOverlay);
  if (malformed) throw invalidCommandArguments(declaration.usage, malformed.message);

  return Object.freeze({
    positionals: Object.freeze(positionals),
    readWorkflowValue: (flag: string) => workflowValues.get(flag) ?? null,
    hasWorkflowFlag: (flag: string) => workflowFlagsSeen.has(flag),
    supplies: (path: string) => Object.prototype.hasOwnProperty.call(parsed.callerOverlay, path)
      || (parsed.canonicalBase !== null && Object.prototype.hasOwnProperty.call(parsed.canonicalBase, path)),
    compose: (resolved) => {
      const overlap = Object.keys(resolved).filter((path) => (
        Object.prototype.hasOwnProperty.call(parsed.callerOverlay, path)
      ));
      if (overlap.length > 0) {
        return parseFailure(`Provide ${overlap.join(', ')} only once.`);
      }
      return composeActionCliInput({
        parsed: { ...parsed, callerOverlay: { ...parsed.callerOverlay, ...resolved } },
        canonicalSchema: spec.inputSchema,
        wholeInputSchema: compiled.wholeInputSchema,
        callerSchema: compiled.callerSchema,
        bindInput: compiled.bindInput,
        context: {
          actionId: declaration.actionId,
          invocationId: randomUUID(),
          output: workflowFlagsSeen.has(ACTION_CLI_JSON_OUTPUT_FLAG) ? 'json' : 'human',
        },
      });
    },
  });
}
