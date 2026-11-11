import { createCodexAppServerStreamEventBridge } from '../streamEventBridge';
import type { CodexRolloutAction } from '../../localControl/rolloutMapper';
import { codexNativeProjectionError } from '../../utils/codexNativeProjectionError';

/** The native history API returns the same completed items as live app-server notifications. */
export function projectCodexNativeHistoryItem(item: Readonly<Record<string, unknown>>): CodexRolloutAction[] {
  const bridge = createCodexAppServerStreamEventBridge();
  const updates = bridge.onNotification({
    method: item.type === 'userMessage' ? 'item/started' : 'item/completed', params: { item },
  });
  const actions: CodexRolloutAction[] = [];
  for (const update of updates) {
    switch (update.type) {
      case 'provider-user-text': actions.push({ type: 'user-text', text: update.text, ...(update.clientId ? { clientId: update.clientId } : {}), ...(update.nativeContent ? { nativeContent: update.nativeContent } : {}) }); break;
      case 'assistant-text-final':
      case 'async-user-input-request': actions.push({ type: 'assistant-text', text: update.text }); break;
      case 'tool-call': actions.push({ type: 'tool-call', callId: update.callId, name: update.name, input: update.input }); break;
      case 'tool-result': actions.push({ type: 'tool-result', callId: update.callId, output: update.output }); break;
      case 'context-compaction': actions.push({ type: 'context-compaction', phase: 'completed', lifecycleId: `codex:context-compaction:${update.itemId}`, source: 'provider-event', providerEventId: update.itemId }); break;
      case 'reasoning-final': actions.push({ type: 'thinking', text: update.text }); break;
      default: throw codexNativeProjectionError('transcript item', item.type);
    }
  }
  if (updates.length === 0 && !['reasoning', 'hookPrompt'].includes(String(item.type))) {
    throw codexNativeProjectionError('transcript item', item.type);
  }
  return actions;
}
