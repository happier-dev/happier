import type { SDKMessage } from '@/backends/claude/sdk';

export function extractTextDeltaFromStreamEvent(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as any;
  if (m.type !== 'stream_event') return null;

  const event = m.event;
  if (!event || typeof event !== 'object') return null;
  if (event.type !== 'content_block_delta') return null;

  const delta = event.delta;
  if (!delta || typeof delta !== 'object') return null;
  if (delta.type !== 'text_delta') return null;

  return typeof delta.text === 'string' ? delta.text : null;
}

export function extractTextStartFromStreamEvent(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as any;
  if (m.type !== 'stream_event') return null;

  const event = m.event;
  if (!event || typeof event !== 'object') return null;
  if (event.type !== 'content_block_start') return null;

  const block = (event as any).content_block;
  if (!block || typeof block !== 'object') return null;
  if (block.type !== 'text') return null;

  return typeof block.text === 'string' ? block.text : null;
}

export function extractThinkingDeltaFromStreamEvent(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as any;
  if (m.type !== 'stream_event') return null;

  const event = m.event;
  if (!event || typeof event !== 'object') return null;
  if (event.type !== 'content_block_delta') return null;

  const delta = event.delta;
  if (!delta || typeof delta !== 'object') return null;
  if (delta.type !== 'thinking_delta') return null;

  return typeof (delta as any).thinking === 'string' ? (delta as any).thinking : null;
}

export function extractThinkingStartFromStreamEvent(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as any;
  if (m.type !== 'stream_event') return null;

  const event = m.event;
  if (!event || typeof event !== 'object') return null;
  if (event.type !== 'content_block_start') return null;

  const block = (event as any).content_block;
  if (!block || typeof block !== 'object') return null;
  if (block.type !== 'thinking') return null;

  return typeof block.thinking === 'string' ? block.thinking : null;
}

export type StreamEventToolUseStart = { id: string; name: string; input: unknown };

export function extractToolUseStartFromStreamEvent(message: unknown): StreamEventToolUseStart | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as any;
  if (m.type !== 'stream_event') return null;

  const event = m.event;
  if (!event || typeof event !== 'object') return null;
  if (event.type !== 'content_block_start') return null;

  const block = (event as any).content_block;
  if (!block || typeof block !== 'object') return null;
  if (block.type !== 'tool_use') return null;

  const id = typeof (block as any).id === 'string' ? (block as any).id : null;
  const name = typeof (block as any).name === 'string' ? (block as any).name : null;
  if (!id || !name) return null;

  return { id, name, input: (block as any).input };
}

export function extractToolUseInputJsonDeltaFromStreamEvent(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as any;
  if (m.type !== 'stream_event') return null;

  const event = m.event;
  if (!event || typeof event !== 'object') return null;
  if (event.type !== 'content_block_delta') return null;

  const delta = (event as any).delta;
  if (!delta || typeof delta !== 'object') return null;
  if (delta.type !== 'input_json_delta') return null;

  const partialJson = (delta as any).partial_json;
  return typeof partialJson === 'string' ? partialJson : null;
}

export type StreamEventToolResultStart = { toolUseId: string; content: string; isError: boolean };

export function extractToolResultStartFromStreamEvent(message: unknown): StreamEventToolResultStart | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as any;
  if (m.type !== 'stream_event') return null;

  const event = m.event;
  if (!event || typeof event !== 'object') return null;
  if (event.type !== 'content_block_start') return null;

  const block = (event as any).content_block;
  if (!block || typeof block !== 'object') return null;
  if (block.type !== 'tool_result') return null;

  const toolUseId =
    typeof (block as any).tool_use_id === 'string'
      ? (block as any).tool_use_id
      : typeof (block as any).toolUseId === 'string'
        ? (block as any).toolUseId
        : null;
  if (!toolUseId) return null;
  const contentRaw = (block as any).content;
  const content = (() => {
    if (typeof contentRaw === 'string') return contentRaw;
    if (!Array.isArray(contentRaw)) return '';
    const parts: string[] = [];
    for (const item of contentRaw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      if ((item as any).type !== 'text') continue;
      const text = (item as any).text;
      if (typeof text === 'string') parts.push(text);
    }
    return parts.join('');
  })();
  const isError = typeof (block as any).is_error === 'boolean' ? Boolean((block as any).is_error) : false;
  return { toolUseId, content, isError };
}

export function isContentBlockStopStreamEvent(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const m = message as any;
  if (m.type !== 'stream_event') return false;
  const event = m.event;
  if (!event || typeof event !== 'object') return false;
  return event.type === 'content_block_stop';
}

export function isMessageStopStreamEvent(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const m = message as any;
  if (m.type !== 'stream_event') return false;
  const event = m.event;
  if (!event || typeof event !== 'object') return false;
  return event.type === 'message_stop';
}

export function messageContainsToolUseId(message: unknown, toolUseId: string): boolean {
  if (!message || typeof message !== 'object') return false;
  const m = message as any;
  if (m.type !== 'assistant') return false;
  const content = m.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((c: any) => c?.type === 'tool_use' && c?.id === toolUseId);
}

export function messageContainsToolResultForToolUseId(message: unknown, toolUseId: string): boolean {
  if (!message || typeof message !== 'object') return false;
  const m = message as any;
  if (m.type !== 'user' && m.type !== 'assistant') return false;
  const content = m.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((c: any) => c?.type === 'tool_result' && c?.tool_use_id === toolUseId);
}

export function recordSeenToolBlocks(message: SDKMessage, seen: { toolUseIds: Set<string>; toolResultIds: Set<string> }): void {
  const m = message as any;
  const content = m?.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      seen.toolUseIds.add(block.id);
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      seen.toolResultIds.add(block.tool_use_id);
    }
  }
}

export function stripSeenToolBlocksFromMessage(
  message: SDKMessage,
  seen: { toolUseIds: Set<string>; toolResultIds: Set<string> },
): SDKMessage | null {
  const m = message as any;
  const content = m?.message?.content;
  if (!Array.isArray(content)) return message;

  let didChange = false;
  const filtered: any[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      filtered.push(block);
      continue;
    }

    if (block.type === 'tool_use' && typeof block.id === 'string') {
      if (seen.toolUseIds.has(block.id)) {
        didChange = true;
        continue;
      }
      filtered.push(block);
      continue;
    }

    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      if (seen.toolResultIds.has(block.tool_use_id)) {
        didChange = true;
        continue;
      }
      filtered.push(block);
      continue;
    }

    filtered.push(block);
  }

  if (!didChange) return message;
  if (filtered.length === 0) return null;
  return {
    ...m,
    message: {
      ...(m?.message ?? {}),
      content: filtered,
    },
  } as SDKMessage;
}
