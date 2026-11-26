import { readDaemonTerminalPtyConfig } from './config';
import type { HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import { withHostProcessOwnerEnvironment } from '@/processes/ownerTag';
import { createTerminalPtySessionManager, type TerminalPtySessionManager } from './sessions';

let agentTerminals: TerminalPtySessionManager | undefined;

/**
 * This process's one owner of its Sessions' Agent terminals (spawn or adopt, byte ring,
 * readers, input, resize). Session holders launch its primary Agents and auxiliary
 * native presenters. Local attach viewers read from the same stream owner.
 */
export function getAgentTerminalSessionManager(): TerminalPtySessionManager {
  agentTerminals ??= createTerminalPtySessionManager({ config: readDaemonTerminalPtyConfig(process.env).sessionManager });
  return agentTerminals;
}

const providerPresentationKey = 'provider-presentation';

export async function runAgentTerminalPresentation(input: Readonly<{
  sessionId: string;
  workingDirectory: string;
  launch: HostAuthorizedPluginExecLaunch;
  signal?: AbortSignal;
  onAttached(): Promise<void>;
}>): Promise<number> {
  const terminals = getAgentTerminalSessionManager();
  const opened = await terminals.ensure({
    terminalKey: providerPresentationKey,
    sessionId: input.sessionId,
    cwd: input.workingDirectory,
    authorizedNativeLaunch: { ...input.launch,
      env: withHostProcessOwnerEnvironment(input.launch.env, input.launch.processOwnerTag) },
    auxiliaryAgent: true,
    signal: input.signal,
  });
  if (!opened.ok) throw Object.assign(new Error(opened.error), { code: opened.errorCode });
  const { terminalId } = opened;
  const exit = terminals.waitForExit({ terminalId });
  const stop = () => terminals.requestStop({ terminalId });
  const onAbort = () => { void stop(); };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    input.signal?.throwIfAborted();
    await input.onAttached();
    const result = await exit;
    return result.kind === 'exited' ? result.exit.exitCode ?? 1 : 1;
  } catch (error) {
    await stop();
    await exit;
    throw error;
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
  }
}

export function findAgentTerminalPresentation(sessionId: string) {
  return getAgentTerminalSessionManager().list().find(entry =>
    entry.sessionId === sessionId && entry.terminalKey === providerPresentationKey);
}

export function closeAgentTerminalPresentation(sessionId: string): void {
  const presentation = findAgentTerminalPresentation(sessionId);
  if (presentation?.ended) getAgentTerminalSessionManager().close({ terminalId: presentation.terminalId });
}
