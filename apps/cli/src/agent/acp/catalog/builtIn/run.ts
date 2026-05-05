import type { AgentId } from '@happier-dev/agents';
import { runHostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';

import type { Credentials } from '@/persistence';
import type { PermissionMode } from '@/api/types';
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { createBuiltInSessionPlan } from './sessionPlan';

export async function runBuiltInAgent(
  agentId: AgentId,
  opts: HostSessionRuntimeRunOptions & {
    credentials: Credentials;
    permissionMode?: PermissionMode;
  },
): Promise<void> {
  await runHostSessionRuntimePlan(createBuiltInSessionPlan(agentId, opts));
}
