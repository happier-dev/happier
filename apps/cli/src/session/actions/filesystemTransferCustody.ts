import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

/** Generic Agent/MCP JSON calls have no local byte reader or destination. */
export function resolveFilesystemTransferCustodyFailure(actionId: string, context: Pick<ActionExecutorContext, 'surface'>) {
  if ((actionId === 'daemon.filesystem.upload' || actionId === 'daemon.filesystem.download')
    && (context.surface === 'mcp' || context.surface === 'agent')) {
    return { ok: false as const, errorCode: 'filesystem_transfer_custody_required',
      error: 'Use the prepared file-transfer driver with a concrete source reader or download destination.' };
  }
  return null;
}
