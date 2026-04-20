import type { HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';

import { createClaudeSessionRuntimePlan } from '../runtime/createSessionPlan';

export async function createClaudeSessionBinding(sessionParams: unknown): Promise<HostSessionRuntimePlan> {
  return createClaudeSessionRuntimePlan(sessionParams);
}
