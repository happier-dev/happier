import type { NewSessionRequest } from '@agentclientprotocol/sdk';

import { logger } from '@/ui/logger';
import { createAcpRequestFailureLogRecord, readAcpRequestErrorCode } from '../withRetry';

/** Only a definite provider rejection naming one passed server permits a changed retry. */
export async function recoverMcpSessionStart<T>(params: Readonly<{
  operation: 'NewSession' | 'LoadSession';
  mcpServers: NewSessionRequest['mcpServers'];
  start: (servers: NewSessionRequest['mcpServers']) => Promise<T>;
  continued: (notice: Readonly<{ serverName: string; reason: string }>) => void;
}>): Promise<T> {
  try {
    return await params.start(params.mcpServers);
  } catch (error) {
    // Transport loss/timeouts can conceal a successful start: never replay them.
    if (!(error instanceof Error) || readAcpRequestErrorCode(error) === null) throw error;
    const failures = [...error.message.matchAll(/\bMCP server\s+(['"])(.*?)\1\s+failed to start:\s*(.+)/gi)];
    const failure = failures[0];
    if (failures.length !== 1 || !failure) throw error;
    const serverName = failure[2]!;
    const namedServers = params.mcpServers.filter(server => (
      error.message.includes(`'${server.name}'`) || error.message.includes(`"${server.name}"`)
    ));
    if (namedServers.length !== 1 || namedServers[0]!.name !== serverName) throw error;
    const remaining = params.mcpServers.filter(server => server.name !== serverName);
    logger.debug('[AcpBackend] Retrying session without failed MCP server', {
      serverName, ...createAcpRequestFailureLogRecord({ operation: params.operation, error }),
    });
    const result = await params.start(remaining);
    // Publish only after the retry succeeds; a second failure stays a failure.
    params.continued({ serverName, reason: failure[3]! });
    return result;
  }
}
