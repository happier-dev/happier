import { readProviderEventText, readProviderUserMessageClientId, readProviderUserMessageContent } from '../wire/fields.js';
import { projectCodexAppServerToolEventsFromNotification } from './toolEvents.js';
import type { CodexProjectedRolloutEvent } from '../../../rollout/projection/messages.js';

/**
 * Projects one native history item, or returns `null` for a shape this version
 * cannot project (a newer item family or unsupported content). The caller retains a safe placeholder
 * and reports an unsupported-record diagnostic, as the rollout path does,
 * so one unknown item never fails the whole transcript page.
 */
export function projectCodexNativeHistoryItem(item: Readonly<Record<string, unknown>>): CodexProjectedRolloutEvent[] | null {
  if (item.type === 'userMessage') {
    const content = readProviderUserMessageContent({ item });
    const clientId = readProviderUserMessageClientId({ item });
    return content ? [{ type: 'user-text', ...content, ...(clientId ? { clientId } : {}) }] : null;
  }
  if (item.type === 'agentMessage') {
    const text = readProviderEventText({ item }, ['text', 'message']);
    return text === null ? null : [{ type: 'assistant-text', text, sidechainId: null }];
  }
  const events = projectCodexAppServerToolEventsFromNotification({ method: 'item/completed', notificationParams: { item } });
  if (events.length) return events;
  if (item.type === 'reasoning' || item.type === 'hookPrompt' || item.type === 'contextCompaction') return [];
  return null;
}
