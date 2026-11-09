import { readRecord, readProviderEventText, readProviderUserMessageText } from '../wire/fields.js';
import { projectCodexAppServerToolEventsFromNotification } from './toolEvents.js';
import type { CodexProjectedRolloutEvent } from '../../../rollout/projection/messages.js';

export function projectCodexNativeHistoryItem(item: Readonly<Record<string, unknown>>): CodexProjectedRolloutEvent[] {
  if (item.type === 'userMessage' && (!Array.isArray(item.content) || !item.content.every((part: unknown) => {
    const record = readRecord(part);
    return record?.type === 'text' && typeof record.text === 'string';
  }))) throw new Error('Codex native history contains unsupported user content');
  if (item.type === 'userMessage' || item.type === 'agentMessage') {
    const text = item.type === 'userMessage' ? readProviderUserMessageText({ item }) : readProviderEventText({ item }, ['text', 'message']);
    if (text === null) throw new Error('Codex native history message omitted its text');
    return item.type === 'userMessage' ? [{ type: 'user-text', text }] : [{ type: 'assistant-text', text, sidechainId: null }];
  }
  const events = projectCodexAppServerToolEventsFromNotification({ method: 'item/completed', notificationParams: { item } });
  if (events.length) return events;
  if (item.type === 'reasoning' || item.type === 'hookPrompt' || item.type === 'contextCompaction') return [];
  throw new Error('Codex native history contains an unsupported transcript item');
}
