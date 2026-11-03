import { encodeAgentLaunchFrame, type AgentLaunchSelectedMaterial, type AgentLaunchNativeSocketDirectory } from './agentLaunchFrame';
import { SESSION_MCP_CONTEXT_RELATIVE_PATH, withSessionMcpAgentLaunchMaterial } from './agentLaunchMaterials';
import type { SessionMcpLocalContext } from '@/mcp/runtime/sessionMcpLocalTransport';
import type { AgentIsolationMemberNativeIdentity } from './agentIsolationNativeIdentity';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { join } from 'node:path';

const managedInstallHomeKey = 'HAPPIER_FIRST_PARTY_INSTALL_HOME';
const ambientEnvironmentKeys = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'TZ', managedInstallHomeKey] as const;
const sessionContextFileKey = 'HAPPIER_SESSION_MCP_CONTEXT_FILE';

export type UnixAgentIdentityLaunch = Readonly<{
  command: 'sudo';
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  stdinPreamble: Buffer;
}>;

/** The finalizer supplies already-selected provider values, not the runner's environment authority. */
export function createUnixAgentIdentityLaunch(input: Readonly<{
  managedHappierBinaryPath: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  runtimeHome: string;
  environment: Readonly<Record<string, string | undefined>>;
  selectedEnvironmentKeys: readonly string[];
  selectedMaterials: readonly AgentLaunchSelectedMaterial[];
  sessionMcpContext?: SessionMcpLocalContext | null;
  memberIdentity?: AgentIsolationMemberNativeIdentity;
  nativeSocketDirectory?: AgentLaunchNativeSocketDirectory;
}>): UnixAgentIdentityLaunch {
  const member = input.memberIdentity;
  if (member && !isCanonicalAbsolutePathInsideRoot(member.home, input.runtimeHome)) throw new PluginError({
    code: 'agent_launch_material_invalid', message: 'Selected material belongs to a different requester', retryable: false,
  });
  const selected = {
    runtimeHome: input.runtimeHome,
    environment: Object.fromEntries(Object.entries(input.environment)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    selectedMaterials: input.selectedMaterials.filter(file => file.relativePath !== SESSION_MCP_CONTEXT_RELATIVE_PATH),
  };
  const materialization = input.sessionMcpContext ? withSessionMcpAgentLaunchMaterial(selected, input.sessionMcpContext) : selected;
  const environment: Record<string, string> = {};
  for (const key of new Set([...ambientEnvironmentKeys, ...input.selectedEnvironmentKeys, sessionContextFileKey])) {
    // Happier's custodian/control/Account context never becomes Agent authority.
    // The bridge reference names selected transient material; the public install
    // home is the canonical nonsecret layout input for Agent tools.
    if (key.startsWith('HAPPIER_') && key !== managedInstallHomeKey
      && (key !== sessionContextFileKey || !input.sessionMcpContext)) {
      if (!['HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE', 'HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE'].includes(key)
        || !materialization.selectedMaterials.some(file => join(materialization.runtimeHome, file.relativePath) === materialization.environment[key])) continue;
    }
    const value = materialization.environment[key];
    if (typeof value === 'string') environment[key] = value;
  }
  return {
    command: 'sudo',
    args: ['-n', '-u', member?.username ?? 'happier-agent', '--', input.managedHappierBinaryPath, 'agent-launch'],
    env: {},
    stdinPreamble: encodeAgentLaunchFrame({
      v: 1, executable: input.executable, args: input.args, cwd: input.cwd,
      runtimeHome: materialization.runtimeHome, environment, selectedMaterials: materialization.selectedMaterials,
      ...(input.nativeSocketDirectory ? { nativeSocketDirectory: input.nativeSocketDirectory } : {}),
      ...(member ? { nativeIdentity: { username: member.username, agentUid: member.agentUid,
        agentGid: member.agentGid, home: member.home } } : {}),
    }),
  };
}
