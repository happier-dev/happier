import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import type { SessionWorkStateV1 } from '@happier-dev/protocol';

import type { OpenCodeServerClient } from './server/openCodeServerClient.js';
import { buildOpenCodeTodoWorkState } from './server/openCodeTodoWorkState.js';

export async function publishOpenCodeWorkState(params: Readonly<{
  ctx: PluginContextV1;
  snapshot: SessionWorkStateV1;
  reason: string;
}>): Promise<void> {
  await params.ctx.sessions.writeStateField({
    fieldId: 'runtime.workState',
    value: params.snapshot,
    reason: params.reason,
  });
}

export async function publishOpenCodeNativeTodosWorkState(params: Readonly<{
  ctx: PluginContextV1;
  client: OpenCodeServerClient;
  providerSessionId: string | null;
}>): Promise<void> {
  if (!params.providerSessionId) return;
  const todos = await params.client.sessionTodo({ sessionId: params.providerSessionId });
  const snapshot = buildOpenCodeTodoWorkState({
    backendId: 'opencode',
    agentId: 'opencode',
    updatedAt: Date.now(),
    todos,
  });
  await publishOpenCodeWorkState({
    ctx: params.ctx,
    snapshot,
    reason: 'opencode_todo_updated',
  });
}
