import { expect } from 'vitest';
import { spawnWorkspaceCheckoutNativeBoundary, workspaceCheckoutNativeBoundary as native, type WorkspaceCheckoutNativeChild } from '@/workspaces/activation/workspaceCheckoutNative.testkit';
import type { ChildProcess } from 'node:child_process';

/** Real OS adapters are retained unless the fixture owns that native account or worker. */
export async function requesterWorkspaceSyncExecBoundary(
  actual: typeof import('../../../../../packages/cli-common/src/process/execFileWithDeadline'),
  args: Parameters<typeof actual.execFileWithDeadline>,
) {
  if (args[0] === 'getent') {
    const observed = native.accountLookups.get(JSON.stringify(args[1]));
    if (observed !== undefined) return { stdout: observed, stderr: '' };
  }
  // Load readiness after mocked process modules have settled; its production
  // dependencies also import the OS process adapters being substituted here.
  const { runAgentIsolationMemberReadinessBoundary } = await import('@/daemon/agentIsolation/agentIsolationEffects.testkit');
  const home = native.mounts[0];
  const readiness = await runAgentIsolationMemberReadinessBoundary({ request: args,
    ...(home ? { nativeHome: { path: home.path, uid: home.uid } } : {}) });
  return readiness ?? actual.execFileWithDeadline(...args);
}

export function spawnRequesterWorkspaceSyncProcessBoundary(
  actual: typeof import('node:child_process'), command: string, args: readonly string[],
  options: import('node:child_process').SpawnOptions, member: boolean,
): ChildProcess | WorkspaceCheckoutNativeChild {
  if (command === 'sudo' && args.at(-1) === 'agent-launch') return spawnWorkspaceCheckoutNativeBoundary();
  if (args.includes('synchronizer')) {
    expect(native.identity.getStore()).toBe(member ? 'member' : undefined);
    return actual.spawn('/bin/cat', [], options);
  }
  return actual.spawn(command, args, options);
}
