import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionMediaPublishToolResultRequest } from '@happier-dev/plugin-sdk/sessions';
import { readClaudeProviderIdentityValue } from '../../protocol/providerIdentity.js';
import { RawJSONLinesSchema } from './rawJsonLines.js';
import { buildClaudeJsonlProviderFactLocalId, type ClaudeJsonlProviderFactIdentityContext } from './providerFactIdentity.js';
import { readClaudeNativeToolResultBlock } from './nativeSemanticProjection.js';
import { readClaudeJsonlRowTimestampMs } from './jsonlReplaySuppression.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type ClaudeToolResultMediaPublication = Readonly<{
  sourceMessageId: string;
  request: SessionMediaPublishToolResultRequest;
}>;

/** Read inline media before the bounded transcript projection removes its bytes. */
export function readClaudeToolResultMediaRequests(
  value: unknown,
  context?: ClaudeJsonlProviderFactIdentityContext,
): readonly ClaudeToolResultMediaPublication[] {
  const parsed = RawJSONLinesSchema.safeParse(value);
  if (!parsed.success || (parsed.data.type !== 'user' && parsed.data.type !== 'assistant')) return [];
  const row = parsed.data;
  const content = row.message?.content;
  if (!Array.isArray(content)) return [];
  const sidechainId = readClaudeProviderIdentityValue(row.sidechainId)
    ?? readClaudeProviderIdentityValue(row.parent_tool_use_id) ?? undefined;
  const localId = buildClaudeJsonlProviderFactLocalId({ ...row, ...(sidechainId ? { sidechainId } : {}) }, context);
  if (!localId) return [];
  const createdAtMs = readClaudeJsonlRowTimestampMs(row);
  const requests: ClaudeToolResultMediaPublication[] = [];
  for (const part of content) {
    const block = readClaudeNativeToolResultBlock(part);
    if (!block || !Array.isArray(block.content)) continue;
    const images = block.content.filter(item => isRecord(item) && item.type === 'image');
    if (images.length === 0) continue;
    const media = AgentRuntimeJsonValueSchema.safeParse(images);
    if (!media.success) throw new Error('claude_tool_result_media_invalid');
    requests.push({ sourceMessageId: localId, request: {
      localId: `${localId}:media:${block.callId}`, toolCallId: block.callId, content: media.data,
      ...(sidechainId ? { sidechainId } : {}),
      ...(createdAtMs === null ? {} : { createdAtMs }),
    } });
  }
  return requests;
}
