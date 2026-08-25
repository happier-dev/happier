import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { definePluginDeclarativeDocumentV1 } from '@happier-dev/plugin-sdk/ui';

import { SESSION_CONVERSATIONS_RESOURCE_RUNTIME } from './sessionConversationsResource.js';

export const CHANNELS_SESSION_INFO_RESOURCE_ID = 'session-info-v1';
export const CHANNELS_SESSION_INFO_RESOURCE_MAX_BYTES = 64 * 1024;
function countArray(value: unknown, field: string): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const candidate = (value as Readonly<Record<string, unknown>>)[field];
  return Array.isArray(candidate) ? candidate.length : 0;
}

export const SESSION_INFO_RESOURCE_RUNTIME: PluginDynamicResourceRuntime = {
  async read(options) {
    const source = await SESSION_CONVERSATIONS_RESOURCE_RUNTIME.read(options);
    const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
    const projection: unknown = JSON.parse(text);
    const conversations = countArray(projection, 'bindings');
    const attention = countArray(projection, 'attention');
    return JSON.stringify(definePluginDeclarativeDocumentV1({
      version: 1,
      root: {
        kind: 'group',
        title: 'External conversations',
        description: 'Conversation bridges associated with this Session.',
        children: [
          { kind: 'status', label: 'Conversations', value: String(conversations) },
          { kind: 'status', label: 'Need attention', value: String(attention) },
        ],
      },
    }));
  },
  observe(invalidate, options) {
    return SESSION_CONVERSATIONS_RESOURCE_RUNTIME.observe?.(invalidate, options);
  },
};
