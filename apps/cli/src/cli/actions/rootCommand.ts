import chalk from 'chalk';
import { renderHelpPage } from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';
import { argvBeforeOptionTerminator } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';

import { actionCliCommandUsagePath, listCompiledActionCliCommands, type CompiledActionCliCommand } from './compiledCommands';
import { actionCliEnvelopeKind } from './commandPresentation';
import { ACTION_CLI_HELP_FLAGS } from './parseCommandInput';
import { renderActionCliRootHelpFromDeclarations } from './helpDeclarations';
import { projectActionCliHelpDeclaration } from './commandHelp';

function commandsUnderRoot(prefix: readonly string[]): readonly CompiledActionCliCommand[] {
  return listCompiledActionCliCommands().filter((command) => (
    prefix.every((part, index) => command.path[index] === part) && command.visibility !== 'hidden'
  ));
}

/**
 * Help for a friendly path family the Action catalog owns end to end. Every row
 * comes from a compiled descriptor, so a listed subcommand is always a
 * dispatchable one.
 */
export function renderActionCliRootHelp(root: string, prefix: readonly string[] = [root]): string {
  return renderActionCliRootHelpFromDeclarations(root, prefix, commandsUnderRoot(prefix).map((command) => projectActionCliHelpDeclaration(command)));
}

/**
 * Handles the root itself. An exact compiled leaf never reaches here — dispatch
 * resolves it first — so this owns help and the unknown-subcommand diagnostic.
 */
export async function handleActionCliRootCommand(root: string, context: CommandContext): Promise<void> {
  // Root help, subcommand resolution and diagnostics are CLI control scanning.
  // Once the caller supplied `--`, the remaining bytes are Action-authored
  // literals, never another help/JSON/command signal.
  const args = argvBeforeOptionTerminator(context.args.slice(1));
  const json = wantsJson(context.args);
  const kind = actionCliEnvelopeKind([root]);
  const subcommand = args.find((token) => !token.startsWith('-'));

  if (!subcommand || subcommand === 'help' || ACTION_CLI_HELP_FLAGS.some((flag) => args.includes(flag))) {
    const help = renderActionCliRootHelp(root);
    if (json) {
      await printJsonEnvelope({ ok: true, kind, data: { help } });
      return;
    }
    console.log(help);
    return;
  }

  const path = [root, ...args.filter((token) => !token.startsWith('-'))].join(' ');
  const message = `Unknown command: happier ${path}.`;
  if (json) {
    await printJsonEnvelope(
      { ok: false, kind, error: { code: 'unknown_subcommand', message } },
      { exitCode: 1 },
    );
    return;
  }
  console.error(chalk.red('Error:'), message);
  console.error(renderActionCliRootHelp(root));
  process.exitCode = 1;
}
