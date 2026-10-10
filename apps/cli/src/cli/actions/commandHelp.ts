import { renderHelpPage } from '@happier-dev/cli-common/output';

import {
  listCompiledActionCliCommands,
  type ActionCliField,
  type CompiledActionCliCommand,
} from './compiledCommands';
import type { ActionDefinitionV1 } from '@happier-dev/protocol';
import {
  ACTION_CLI_HELP_FLAGS,
  ACTION_CLI_JSON_OUTPUT_FLAG,
  ACTION_CLI_MACHINE_ID_FLAG,
  ACTION_CLI_REQUEST_ID_FLAG,
  ACTION_CLI_SERVER_ID_FLAG,
  ACTION_CLI_WHOLE_INPUT_FLAG,
} from './parseCommandInput';

export type ActionCliHelpRow = Readonly<{ label: string; description: string }>;

export type ActionCliHelpModel = Readonly<{
  title: string;
  subtitle: string;
  usage: string;
  positionals: readonly ActionCliHelpRow[];
  options: readonly ActionCliHelpRow[];
  /** CLI-owned flags: routing, output mode and the JSON escape hatches. */
  cliOptions: readonly ActionCliHelpRow[];
  notes: readonly string[];
}>;

type ActionCliInvokeHelpOptions = Readonly<{
  actionId: string;
  definition?: ActionDefinitionV1;
  fields: readonly ActionCliField[];
}>;

function buildCliOptionRows(command: CompiledActionCliCommand): readonly ActionCliHelpRow[] {
  return Object.freeze([
    ...(command.routesByTransportMachineId
      ? [{ label: `${command.transportMachineIdFlags.join(', ')} <machineId>`, description: 'Route this invocation to an exact machine' }]
      : []),
    ...(command.acceptsServerId
      ? [{
          label: `${ACTION_CLI_SERVER_ID_FLAG} <serverId>`,
          description: `Use credentials and endpoint for an exact saved Home${command.requiresServerId ? ' [required]' : ''}`,
        }]
      : []),
    { label: `${ACTION_CLI_WHOLE_INPUT_FLAG} <json>`, description: 'Whole Action input as JSON' },
    { label: ACTION_CLI_JSON_OUTPUT_FLAG, description: 'Stable JSON envelope on stdout' },
    { label: ACTION_CLI_HELP_FLAGS.join(', '), description: 'Show this help' },
  ].map((row) => Object.freeze(row)));
}

function describeFieldKind(field: ActionCliField): string {
  switch (field.kind) {
    case 'boolean':
      return 'flag';
    case 'string_list':
      return 'repeatable';
    case 'enum':
      return field.choices ? field.choices.join(' | ') : 'value';
    case 'integer':
    case 'number':
      return 'number';
    case 'json':
      return 'json';
    default:
      return 'value';
  }
}

function optionLabel(field: ActionCliField): string {
  if (field.kind === 'boolean') {
    return [field.flag, ...field.aliases, `--no-${field.flag.slice(2)}`].join(', ');
  }
  const spellings = field.kind === 'json'
    ? [`${field.flag}-json <json>`, ...field.aliases.map((alias) => `${alias} <json>`)]
    : [...[field.flag, ...field.aliases].map((flag) => `${flag} <value>`), `${field.flag}-json <json>`];
  return spellings.join(', ');
}

function optionDescription(field: ActionCliField): string {
  const parts = [field.title ?? field.path, `(${describeFieldKind(field)})`];
  if (field.description) parts.push(field.description);
  if (field.required) parts.push('[required]');
  else if (field.requiredWhen) parts.push('[conditionally required]');
  if (field.visibleWhen) parts.push('[conditionally available]');
  if (field.disabledWhen) parts.push('[conditionally disabled]');
  if (field.listSeparator) {
    parts.push(`${field.listSeparator}-separated${field.maxSelections === null ? '' : `; at most ${field.maxSelections}`}`);
  } else if (field.maxSelections !== null) {
    parts.push(`at most ${field.maxSelections}`);
  }
  if (field.minimum !== null && field.maximum !== null) {
    parts.push(`${field.minimum}–${field.maximum}`);
  } else if (field.minimum !== null) {
    parts.push(`at least ${field.minimum}`);
  } else if (field.maximum !== null) {
    parts.push(`at most ${field.maximum}`);
  }
  if (field.exclusiveMinimum !== null) parts.push(`greater than ${field.exclusiveMinimum}`);
  if (field.exclusiveMaximum !== null) parts.push(`less than ${field.exclusiveMaximum}`);
  return parts.join(' ');
}

/**
 * The option rows every Action-driven command documents its fields with — type,
 * requiredness, conditions, choices and ranges — for built-in, generic-invoke and
 * plugin-contributed commands alike.
 */
export function buildFieldOptionRows(fields: readonly ActionCliField[]): readonly ActionCliHelpRow[] {
  return Object.freeze(fields.map((field) => Object.freeze({
    label: optionLabel(field),
    description: optionDescription(field),
  })));
}

/** Shared help model for generic built-in and contributed Action invocation. */
export function buildActionCliInvokeHelpModel(options: ActionCliInvokeHelpOptions): ActionCliHelpModel {
  const definition = options.definition;
  const notes = definition
    ? [
        `Safety: ${definition.safety}.`,
        `Canonical Action: ${definition.id}.`,
        'Use --<field>-json for one nested value.',
        ...(definition.examples?.mcp?.argsExample
          ? [`Example input: ${definition.examples.mcp.argsExample}`]
          : definition.examples?.voice?.argsExample
            ? [`Example input: ${definition.examples.voice.argsExample}`]
            : []),
      ]
    : [
        `Canonical Action: ${options.actionId}.`,
        'Canonical definition unavailable; this predecessor supports only --input-json.',
      ];
  return Object.freeze({
    title: `happier actions invoke ${options.actionId}`,
    subtitle: definition?.description ?? definition?.title ?? `Invoke ${options.actionId}`,
    usage: `happier actions invoke ${options.actionId} [options]`,
    positionals: Object.freeze([]),
    options: buildFieldOptionRows(options.fields),
    cliOptions: Object.freeze([
      { label: `${ACTION_CLI_WHOLE_INPUT_FLAG} <json>`, description: 'Whole Action input as JSON' },
      { label: `${ACTION_CLI_REQUEST_ID_FLAG} <id>`, description: 'Request correlation identifier' },
      { label: `${ACTION_CLI_SERVER_ID_FLAG} <serverId>`, description: 'Use credentials and endpoint for an exact saved Home' },
      { label: `${ACTION_CLI_MACHINE_ID_FLAG} <machineId>`, description: 'Route this invocation to an exact machine' },
      { label: ACTION_CLI_JSON_OUTPUT_FLAG, description: 'Stable JSON envelope on stdout' },
      { label: ACTION_CLI_HELP_FLAGS.join(', '), description: 'Show this help' },
    ].map((row) => Object.freeze(row))),
    notes: Object.freeze(notes),
  });
}

/**
 * The help model comes from the same compiled descriptor the parser and
 * completion use, so a documented flag is always an accepted flag.
 */
export function buildActionCliHelpModel(command: CompiledActionCliCommand): ActionCliHelpModel {
  const usageArguments = [
    ...command.positionals.map((field) => `<${field.path}>`),
    ...(command.variadicPositional ? [`<${command.variadicPositional.path}...>`] : []),
  ];
  const notes: string[] = [];
  if (command.deprecated) {
    notes.push(
      `Deprecated: use \`${command.deprecated.replacement}\`. Removed when ${command.deprecated.removalCondition}.`,
    );
  }
  if (command.spec.approval?.result === 'required') {
    notes.push('This Action requires approval before it takes effect.');
  }
  notes.push(`Canonical Action: ${command.actionId}.`);
  notes.push('Use --<field>-json for one nested value.');

  return Object.freeze({
    title: `happier ${command.path.join(' ')}`,
    subtitle: command.spec.description ?? command.spec.title,
    usage: `happier ${command.path.join(' ')}${usageArguments.length ? ` ${usageArguments.join(' ')}` : ''} [options]`,
    positionals: Object.freeze([
      ...command.positionals,
      ...(command.variadicPositional ? [command.variadicPositional] : []),
    ].map((field) => Object.freeze({
      // A positional is also reachable by its flag spellings; listing them here
      // keeps them documented without duplicating the row under Options.
      label: [`<${field.path}>`, field.flag, ...field.aliases].join(', '),
      description: field.title ?? field.path,
    }))),
    options: buildFieldOptionRows(
      command.fields.filter((field) => (
          !command.positionals.some((positional) => positional.path === field.path)
          && command.variadicPositional?.path !== field.path
        )),
    ),
    cliOptions: buildCliOptionRows(command),
    notes: Object.freeze(notes),
  });
}

/**
 * One usage line for a nested help index, derived from the same descriptor as
 * the command's own help page. A migrated leaf therefore cannot be listed with a
 * grammar its parser does not accept.
 */
export function buildActionCliCommandUsageLine(command: CompiledActionCliCommand): string {
  const positionals = [
    ...command.positionals.map((field) => `<${field.path}>`),
    ...(command.variadicPositional ? [`<${command.variadicPositional.path}...>`] : []),
  ];
  const options = command.fields
    .filter((field) => (
      !command.positionals.some((positional) => positional.path === field.path)
      && command.variadicPositional?.path !== field.path
    ))
    .map((field) => (field.kind === 'boolean'
      ? `[${field.flag}]`
      : field.kind === 'json'
        ? `[${field.aliases[0] ?? `${field.flag}-json`} <json>]`
        : `[${field.flag} <value>]`));
  const deprecation = command.deprecated
    ? ` (deprecated: use "${command.deprecated.replacement}")`
    : '';
  return [
    `happier ${command.path.join(' ')}`,
    ...positionals,
    ...options,
    '[--json]',
  ].join(' ') + deprecation;
}

/**
 * One usage line for every compiled command dispatched under `path`, for the
 * family help a static root or nested subcommand owns. The rows come from the
 * same descriptor as dispatch and completion, so a compiled leaf under a root
 * that keeps its own help page cannot be invisible there.
 */
export function listCompiledActionCliUsageLinesForRoot(
  path: readonly string[],
  commands: readonly CompiledActionCliCommand[] = listCompiledActionCliCommands(),
): readonly string[] {
  return commands
    .filter((command) => (
      command.visibility !== 'hidden'
      && command.path.length >= path.length
      && path.every((segment, index) => command.path[index] === segment)
    ))
    .map((command) => buildActionCliCommandUsageLine(command));
}

export function renderActionCliCommandHelp(command: CompiledActionCliCommand): string {
  return renderActionCliHelpModel(buildActionCliHelpModel(command));
}

export function renderActionCliHelpModel(model: ActionCliHelpModel): string {
  return renderHelpPage({
    title: model.title,
    subtitle: model.subtitle,
    usage: [{ label: model.usage, description: '' }],
    sections: [
      { title: 'Arguments:', rows: [...model.positionals] },
      { title: 'Options:', rows: [...model.options] },
      { title: 'CLI options:', rows: [...model.cliOptions] },
    ],
    notes: [...model.notes],
  });
}
