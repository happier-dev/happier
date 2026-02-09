import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { CodexMcpClient } from '@/backends/codex/codexMcpClient';
import type { createCodexAcpRuntime } from '@/backends/codex/acp/runtime';

type CleanupRunResourcesOptions = Readonly<{
  session: ApiSessionClient;
  reconnectionHandle: { cancel: () => void } | null;
  client: CodexMcpClient | null;
  codexAcpRuntime: ReturnType<typeof createCodexAcpRuntime> | null;
  stopHappierMcpServer: () => void;
  unmountRemoteUi: () => Promise<void>;
  keepAliveInterval: ReturnType<typeof setInterval>;
  messageBuffer: MessageBuffer;
  logDebug: (message: string, error?: unknown) => void;
  logActiveHandles: (tag: string) => void;
}>;

export async function cleanupCodexRunResources(opts: CleanupRunResourcesOptions): Promise<void> {
  opts.logDebug('[codex]: Final cleanup start');
  opts.logActiveHandles('cleanup-start');

  if (opts.reconnectionHandle) {
    opts.logDebug('[codex]: Cancelling offline reconnection');
    opts.reconnectionHandle.cancel();
  }

  try {
    opts.logDebug('[codex]: sendSessionDeath');
    opts.session.sendSessionDeath();
    opts.logDebug('[codex]: flush begin');
    await opts.session.flush();
    opts.logDebug('[codex]: flush done');
    opts.logDebug('[codex]: session.close begin');
    await opts.session.close();
    opts.logDebug('[codex]: session.close done');
  } catch (e) {
    opts.logDebug('[codex]: Error while closing session', e);
  }

  if (opts.client) {
    opts.logDebug('[codex]: client.forceCloseSession begin');
    await opts.client.forceCloseSession();
    opts.logDebug('[codex]: client.forceCloseSession done');
  } else {
    await opts.codexAcpRuntime?.reset();
  }

  opts.logDebug('[codex]: happierMcpServer.stop');
  opts.stopHappierMcpServer();

  await opts.unmountRemoteUi();
  opts.logDebug('[codex]: clearInterval(keepAlive)');
  clearInterval(opts.keepAliveInterval);
  opts.messageBuffer.clear();

  opts.logActiveHandles('cleanup-end');
  opts.logDebug('[codex]: Final cleanup completed');
}

