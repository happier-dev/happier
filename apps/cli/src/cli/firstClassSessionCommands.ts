import type { CommandContext, CommandHandler } from './commandRegistry';

export type FirstClassSessionCommandDescriptor = Readonly<{
  command: string;
  aliases?: readonly string[];
  sessionPath: readonly string[];
  rootHelpLabel: string;
  rootHelpDescription: string;
  handler: CommandHandler;
}>;

function delegateToSessionCommand(sessionPath: readonly string[]): CommandHandler {
  return async (context: CommandContext) => {
    if (context.args.slice(1).some((arg) => arg === '--help' || arg === '-h')) {
      const { formatFirstClassSessionCommandHelp } = await import('./commands/session/shared/sessionCommandUsage');
      const command = context.args[0] ?? sessionPath[0] ?? 'session';
      console.log(formatFirstClassSessionCommandHelp({ command, sessionPath }));
      return;
    }
    const { handleSessionCliCommand } = await import('./commands/session');
    await handleSessionCliCommand({
      ...context,
      args: ['session', ...sessionPath, ...context.args.slice(1)],
    });
  };
}

/** First-class commands only project argv into the canonical session owner. */
export const FIRST_CLASS_SESSION_COMMANDS: readonly FirstClassSessionCommandDescriptor[] = Object.freeze([
  {
    command: 'spawn',
    sessionPath: ['create'],
    rootHelpLabel: 'happier spawn [options]',
    rootHelpDescription: 'Create a session',
    handler: delegateToSessionCommand(['create']),
  },
  {
    command: 'list',
    aliases: ['ls'],
    sessionPath: ['list'],
    rootHelpLabel: 'happier list [options]',
    rootHelpDescription: 'List sessions',
    handler: delegateToSessionCommand(['list']),
  },
  {
    command: 'send',
    sessionPath: ['send'],
    rootHelpLabel: 'happier send <session> <message>',
    rootHelpDescription: 'Send a message to a session',
    handler: delegateToSessionCommand(['send']),
  },
  {
    command: 'history',
    sessionPath: ['history'],
    rootHelpLabel: 'happier history <session> [options]',
    rootHelpDescription: 'Read or follow a session transcript',
    handler: delegateToSessionCommand(['history']),
  },
  {
    command: 'wait',
    sessionPath: ['wait'],
    rootHelpLabel: 'happier wait <session> [options]',
    rootHelpDescription: 'Wait for a session to become idle',
    handler: delegateToSessionCommand(['wait']),
  },
  {
    command: 'stop',
    sessionPath: ['stop'],
    rootHelpLabel: 'happier stop <session>',
    rootHelpDescription: 'Stop a session',
    handler: delegateToSessionCommand(['stop']),
  },
  {
    command: 'delegate',
    sessionPath: ['delegate', 'start'],
    rootHelpLabel: 'happier delegate <session> <instructions> --agent <agent>',
    rootHelpDescription: 'Delegate work from a session',
    handler: delegateToSessionCommand(['delegate', 'start']),
  },
]);
