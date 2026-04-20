import type { Credentials } from '@/persistence';
import type { PermissionMode } from '@/api/types';
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/sessionLoop/runHostSessionRuntime';
import { runHostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';
import { createConfiguredAcpSessionRuntimePlan } from './sessionPlan';

export async function runConfiguredAcpBackend(
  opts: HostSessionRuntimeRunOptions & {
    credentials: Credentials;
    permissionMode?: PermissionMode;
    backendTarget: { kind: 'configuredAcpBackend'; backendId: string };
    happyHomeDir?: string;
  },
): Promise<void> {
  await runHostSessionRuntimePlan(await createConfiguredAcpSessionRuntimePlan(opts));
}
