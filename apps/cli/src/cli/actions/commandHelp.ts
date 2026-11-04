import { buildFieldOptionRows } from './fieldHelp';
export { buildFieldOptionRows } from './fieldHelp';
import { ActionCliHelpRow, ActionCliHelpModel, renderActionCliHelpModel } from './helpModel';
import type { ActionCliHelpDeclaration } from './helpDeclarations';
import { actionCliCommandPattern } from './commandPatterns';
import { actionCliEnvelopeKind } from './commandPresentationMetadata';
export { renderActionCliHelpModel } from './helpModel';
export type { ActionCliHelpRow, ActionCliHelpModel } from './helpModel';
import { renderHelpPage } from '@happier-dev/cli-common/output';

import {
  listCompiledActionCliCommands,
  actionCliCommandUsagePath,
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
      { label: `${ACTION_CLI_REQUEST_ID_FLAG} <id>`, description: 'Request correlation identifier; do not reuse after a daemon restart to mean "the same request"' },
      { label: `${ACTION_CLI_SERVER_ID_FLAG} <serverId>`, description: 'Use credentials and endpoint for an exact saved Home' },
      { label: `${ACTION_CLI_MACHINE_ID_FLAG} <machineId>`, description: 'Route this invocation to an exact machine' },
      { label: '--yes', description: 'Approve requested Action confirmations without prompting' },
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
    ...command.positionals.slice(command.positionalsBeforeLastSegment.length).map((field) => `<${field.path}>`),
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
  if (command.positionalsBeforeLastSegment.length) notes.push('A command target repeated in --input-json must match its positional selector.');

  return Object.freeze({
    title: `happier ${command.path.join(' ')}`,
    subtitle: command.spec.description ?? command.spec.title,
    usage: `happier ${actionCliCommandUsagePath(command)}${usageArguments.length ? ` ${usageArguments.join(' ')}` : ''} [options]`,
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
    ...command.positionals.slice(command.positionalsBeforeLastSegment.length).map((field) => `<${field.path}>`),
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
    `happier ${actionCliCommandUsagePath(command)}`,
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

export function projectActionCliHelpDeclaration(command: CompiledActionCliCommand, envelopeKind = actionCliEnvelopeKind(command.path)): ActionCliHelpDeclaration {
  return {
    actionId: command.actionId, path: command.path, visibility: command.visibility,
    pattern: actionCliCommandPattern(command), title: command.spec.title, envelopeKind,
    usageLine: buildActionCliCommandUsageLine(command),
    rootUsageLine: `happier ${actionCliCommandUsagePath(command)}${
      command.actionId === 'workflow.definition.import' ? ' <file|->'
      : command.actionId === 'workflow.definition.export' ? ' <definition-id> [file|-]'
      : command.positionals.length || command.variadicPositional
        ? ` ${[
            ...command.positionals.slice(command.positionalsBeforeLastSegment.length).map((field) => `<${field.path}>`),
            ...(command.variadicPositional ? [`<${command.variadicPositional.path}...>`] : []),
          ].join(' ')}`
        : ''
    }`,
    help: buildActionCliHelpModel(command),
  };
}
