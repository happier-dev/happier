import { readDaemonTerminalPtyConfig } from './config';
import { createTerminalPtySessionManager, type TerminalPtySessionManager } from './sessions';

let agentTerminals: TerminalPtySessionManager | undefined;

/**
 * This process's one owner of its Sessions' Agent terminals (spawn or adopt, byte ring,
 * readers, input, resize). The PTY terminal host drives its Agents through it and local
 * attach viewers read from it. Its Agents are held by their Session holders, so it spawns
 * no terminal itself; the daemon's machine terminals have their own manager.
 */
export function getAgentTerminalSessionManager(): TerminalPtySessionManager {
  agentTerminals ??= createTerminalPtySessionManager({ config: readDaemonTerminalPtyConfig(process.env).sessionManager });
  return agentTerminals;
}
