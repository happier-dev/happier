import { expect } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import type { ToolNameContext } from '@/agent/transport/TransportHandler';

export const DEFAULT_TOOL_NAME_CONTEXT: ToolNameContext = {
  recentPromptHadChangeTitle: false,
  toolCallCountSincePrompt: 0,
};

export function asStatusErrorMessage(message: AgentMessage | null | undefined): Extract<AgentMessage, { type: 'status' }> {
  expect(message).not.toBeNull();
  expect(message?.type).toBe('status');
  const statusMessage = message as Extract<AgentMessage, { type: 'status' }>;
  expect(statusMessage.status).toBe('error');
  return statusMessage;
}
