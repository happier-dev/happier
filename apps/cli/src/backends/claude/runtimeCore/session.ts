import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';

import { createClaudeSessionRuntimePlan } from '../runtime/createSessionPlan';

export async function createClaudeSessionRuntime(sessionParams: unknown): Promise<HostSessionRuntimePlan> {
  return createClaudeSessionRuntimePlan(sessionParams);
}
