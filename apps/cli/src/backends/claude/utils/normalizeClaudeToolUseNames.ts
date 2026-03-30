import type { RawJSONLines } from '@/backends/claude/types';
import type { SDKMessage } from '@/backends/claude/sdk';

export function normalizeClaudeToolNameToCanonicalToolNameV2(rawName: string): string {
  const name = String(rawName ?? '');
  switch (name) {
    case 'TeamCreate':
      return 'AgentTeamCreate';
    case 'TeamDelete':
      return 'AgentTeamDelete';
    case 'Agent':
      // Claude Code Agent Teams uses `Agent` tool_use blocks for teammate lifecycles. Canonicalize it
      // to the provider-agnostic SubAgent tool so UI renderers and sidechain transcript handling apply.
      return 'SubAgent';
    case 'SendMessage':
    case 'sendMessage':
      return 'AgentTeamSendMessage';
    default:
      return name;
  }
}

function normalizeToolUseNamesInContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let didChange = false;
  const next = content.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
    const record = block as Record<string, unknown>;
    if (record.type !== 'tool_use') return block;
    const name = typeof record.name === 'string' ? record.name : null;
    if (!name) return block;
    const normalized = normalizeClaudeToolNameToCanonicalToolNameV2(name);
    if (normalized === name) return block;
    didChange = true;
    return { ...record, name: normalized };
  });
  return didChange ? next : content;
}

export function normalizeClaudeToolUseNamesInRawJsonLines(message: RawJSONLines): RawJSONLines {
  if (message.type !== 'assistant') return message;
  const msg: any = message as any;
  const content = msg?.message?.content;
  const normalized = normalizeToolUseNamesInContent(content);
  if (normalized === content) return message;
  return { ...msg, message: { ...msg.message, content: normalized } };
}

export function normalizeClaudeToolUseNamesInSdkMessage(message: SDKMessage): SDKMessage {
  if (!message || typeof message !== 'object') return message;
  const m: any = message as any;
  if (m.type !== 'assistant' && m.type !== 'user') return message;
  const content = m?.message?.content;
  const normalized = normalizeToolUseNamesInContent(content);
  if (normalized === content) return message;
  return { ...m, message: { ...m.message, content: normalized } };
}
