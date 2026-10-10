import { isGenericSubAgentToolName } from '@happier-dev/protocol';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';

import type { AcpBackend } from '@/agent/acp/AcpBackend';
import { importAcpReplaySidechainV1 } from '@/agent/acp/history/importAcpReplaySidechain';
import type { AcpReplaySidechainSessionClient } from '@/agent/acp/sessionClient';
import { canonicalizeToolNameV2 } from '@/agent/tools/normalization';
import { logger } from '@/utils/logger';

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export function importToolSidechain(params: Readonly<{
  agentId: string;
  toolName: string;
  sidechainId: string;
  result: unknown;
  session: AcpReplaySidechainSessionClient;
  isCurrent(): boolean;
  createReplayBackend(): AcpBackend;
}>): Promise<void> | null {
  if (!isGenericSubAgentToolName(canonicalizeToolNameV2({ protocol: 'acp', toolName: params.toolName }))) return null;
  const result = record(params.result);
  const metadata = record(result?.metadata);
  const output = typeof result?.output === 'string' ? result.output : '';
  const content = typeof result?.content === 'string' ? result.content : output;
  const embeddedSessionId = output.match(/<task_metadata>[\s\S]*?session_id:\s*([^\s<]+)[\s\S]*?<\/task_metadata>/i)?.[1];
  const remoteSessionId = readNonBlankOpaqueIdentifier(metadata?.sessionId ?? embeddedSessionId);
  if (!remoteSessionId || !params.isCurrent()) return null;
  const fallback = content.replace(/<task_metadata>[\s\S]*?<\/task_metadata>/gi, '').trim();
  return (async () => {
    const backend = params.createReplayBackend();
    try {
      let replay: ReadonlyArray<unknown> = [];
      try {
        const loaded = await backend.loadSessionWithReplayCapture(remoteSessionId);
        if (loaded.sessionId !== remoteSessionId) throw new Error('ACP child replay returned a different provider session');
        replay = loaded.replay;
      } catch (error) {
        logger.warn(`[${params.agentId}] Child replay unavailable; using its launch result`, error);
      }
      if (!params.isCurrent()) return;
      await importAcpReplaySidechainV1({
        session: params.session,
        provider: params.agentId,
        remoteSessionId,
        sidechainId: params.sidechainId,
        replay: replay.length > 0 ? replay : fallback ? [{ type: 'message', role: 'agent', text: fallback }] : [],
      });
    } finally {
      await backend.dispose({ preserveProviderSession: true });
    }
  })();
}
