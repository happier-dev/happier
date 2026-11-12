import { PluginError } from '@happier-dev/plugin-sdk';
import { resolveMachineAgentExecutionPlacementV1 } from '@happier-dev/protocol';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { z } from 'zod';

import type { AgentLaunchMaterialization } from '@/daemon/agentIsolation/agentLaunchMaterials';
import type { HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { AgentIsolationMemberNativeIdentity } from '@/daemon/agentIsolation/agentIsolationNativeIdentity';
import { createUnixAgentIdentityLaunch } from '@/daemon/agentIsolation/unixAgentIdentityAdapter';
import { runMemberAgentEffect } from '@/daemon/agentIsolation/runMemberNativeOperation';
import { buildMemberAgentInstallEnvironment } from '@/capabilities/installJobs/memberInstallEnvironment';
import { readMemberAgentSharedManagedToolsRoot } from '@/capabilities/installJobs/memberResolveEffect';
import type { AgentCliLaunchSpec } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';

export type MemberAgentCliLaunchContext = Readonly<{
    memberIdentity: AgentIsolationMemberNativeIdentity;
    managedHappierBinaryPath: string;
    runtimeHome: string;
    signal?: AbortSignal;
}>;

export function createMemberAgentCliLaunchContext(input: Readonly<{
    material?: Pick<AgentLaunchMaterialization, 'runtimeHome' | 'memberIdentity'>;
    managedHappierBinaryPath?: string;
    signal?: AbortSignal;
}>): MemberAgentCliLaunchContext | undefined {
    if (!input.material?.memberIdentity) return undefined;
    if (!input.managedHappierBinaryPath) throw new PluginError({ code: 'agent_isolation_unavailable',
        message: 'Current member launch material is unavailable', retryable: false });
    return { memberIdentity: input.material.memberIdentity, runtimeHome: input.material.runtimeHome,
        managedHappierBinaryPath: input.managedHappierBinaryPath, signal: input.signal };
}

/** Consume the operation/Session owner's admitted native selection. */
export function readMemberAgentCliLaunchContext(context?: HostAgentIsolationLaunchContext): MemberAgentCliLaunchContext | undefined {
    const snapshot = context?.read();
    if (!snapshot || resolveMachineAgentExecutionPlacementV1({ policy: snapshot, platform: process.platform }) !== 'member') return undefined;
    if (!snapshot.memberIdentity || !snapshot.launch) throw new PluginError({ code: 'agent_isolation_unavailable',
        message: 'Current member launch material is unavailable', retryable: false });
    return createMemberAgentCliLaunchContext({ material: { ...snapshot.launch, memberIdentity: snapshot.memberIdentity },
        managedHappierBinaryPath: snapshot.launch.managedHappierBinaryPath });
}

const resolvedRecord = z.object({ t: z.literal('resolved'), launch: z.object({
    source: z.enum(['override', 'system', 'managed']), resolvedPath: z.string(), command: z.string(),
    args: z.array(z.string()), providerExitOwnership: z.literal('direct').optional(),
}).strict().nullable() }).strict();

/** Filesystem resolution happens after the incumbent RunAs switch, never as the daemon. */
export async function resolveMemberRunnableAgentCliLaunch(params: Readonly<{
    agentId: string;
    runtimeSpec: AgentCliRuntimeDescriptor;
    processEnv: NodeJS.ProcessEnv;
    memberLaunch: MemberAgentCliLaunchContext;
}>): Promise<AgentCliLaunchSpec> {
    const member = params.memberLaunch;
    const signal = member.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const environment = buildMemberAgentInstallEnvironment(member.memberIdentity.home);
    const dispatch = createUnixAgentIdentityLaunch({ managedHappierBinaryPath: member.managedHappierBinaryPath,
        executable: member.managedHappierBinaryPath, args: ['agent-install-effect'], cwd: member.memberIdentity.home,
        runtimeHome: member.runtimeHome, environment, selectedEnvironmentKeys: Object.keys(environment),
        selectedMaterials: [], memberIdentity: member.memberIdentity });
    const result = await runMemberAgentEffect({ launch: { ...dispatch, release() {} }, signal,
        request: { kind: 'resolve', runtimeSpec: params.runtimeSpec,
            sharedManagedToolsRoot: readMemberAgentSharedManagedToolsRoot(params.processEnv) },
        readRecord(record) { return resolvedRecord.parse(record); } });
    if (!result.launch) throw new PluginError({ code: 'agent_cli_not_runnable', retryable: false,
        message: `Agent '${params.runtimeSpec.title}' cannot run as this member. Install its Happier-managed runtime.`,
        details: { agentId: params.agentId, remedy: 'install_managed_runtime' } });
    return result.launch;
}
