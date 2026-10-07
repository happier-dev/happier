import { readSlashCommandNames } from '@happier-dev/plugin-sdk/sessions';

export function readClaudeNativeSlashCommands(message: unknown): unknown {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const record = message as Readonly<Record<string, unknown>>;
  return record.type === 'system' ? record.slash_commands : undefined;
}

export function readClaudeNativeCommands(message: unknown): Array<Readonly<{ name: string }>> | null {
  const commands = readClaudeNativeSlashCommands(message);
  return Array.isArray(commands) ? readSlashCommandNames(commands).map((name) => ({ name })) : null;
}
