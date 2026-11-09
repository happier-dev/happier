import type { SessionMediaFailureV1 } from '@happier-dev/protocol';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { SendAgentSessionMediaCommittedRequest } from '@/api/session/client/transcript/sessionMediaBridge';
import { extractAcpMediaContentBlocks } from '@/agent/acp/media/extractAcpMediaContentBlocks';

/** Native adapters supply standard ACP blocks; extraction and persistence remain host-owned. */
export function extractImportedSessionMedia(params: Readonly<{
  content: unknown;
  role: 'user' | 'agent';
  toolCallId?: string;
}>): Pick<SendAgentSessionMediaCommittedRequest, 'role' | 'category' | 'media'> & Readonly<{
  failures: readonly SessionMediaFailureV1[];
}> {
  const category = params.role === 'user' ? 'attachment' : params.toolCallId ? 'tool-artifact' : 'generated';
  const role = params.role === 'user' ? 'input' : 'output';
  const origin = { source: params.toolCallId ? 'tool-output' : 'acp-content',
    ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}) } as const;
  const extracted = extractAcpMediaContentBlocks(params.content, {
    originSource: origin.source, ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
  });
  const failures: SessionMediaFailureV1[] = extracted.diagnostics.map(diagnostic => ({
    index: diagnostic.contentIndex, code: diagnostic.code, role, category, mediaKind: 'image',
    name: `image-${diagnostic.contentIndex + 1}`, origin,
  }));
  return { media: extracted.media, failures, role, category };
}

export async function publishImportedSessionMedia(params: Readonly<{
  session: Pick<TranscriptSessionPort, 'sendAgentSessionMediaCommitted'>;
  provider: ACPProvider;
  localId: string;
  role: 'user' | 'agent';
  text: string;
  content: unknown;
  meta: Record<string, unknown>;
  provenanceSource: 'history' | 'sidechain';
  toolCallId?: string;
  sidechainId?: string;
}>): Promise<boolean> {
  const extracted = extractImportedSessionMedia(params);
  if (!extracted.media.length && !extracted.failures.length) return false;
  const publish = params.session.sendAgentSessionMediaCommitted;
  if (!publish) throw new Error('imported_session_media_unavailable');
  await publish.call(params.session, params.provider, {
    localId: params.localId, role: extracted.role, category: extracted.category,
    media: extracted.media, failures: extracted.failures,
    messageText: extracted.failures.length ? [params.text, '[Image unavailable]'].filter(Boolean).join('\n') : params.text,
    meta: { ...params.meta, ...(extracted.failures.length ? { importedHistoryCoverage: 'partial' } : {}) },
    provenanceSource: params.provenanceSource,
    ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}),
  });
  return true;
}
