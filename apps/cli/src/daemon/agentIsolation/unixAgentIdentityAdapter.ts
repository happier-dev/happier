import { encodeAgentLaunchFrame, type AgentLaunchSelectedMaterial, type AgentLaunchNativeSocketDirectory } from './agentLaunchFrame';
import { SESSION_MCP_CONTEXT_RELATIVE_PATH, withSessionMcpAgentLaunchMaterial } from './agentLaunchMaterials';
import type { SessionMcpLocalContext } from '@/mcp/runtime/sessionMcpLocalTransport';
import type { AgentIsolationMemberNativeIdentity } from './agentIsolationNativeIdentity';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { join } from 'node:path';
import { FIRST_PARTY_INSTALL_HOME_ENV_KEY, MANAGED_TOOLS_ROOT_ENV_KEY } from '@happier-dev/cli-common/firstPartyRuntime';
import { isSessionControlEnvKey } from '@/session/runtime/control/sessionControlEnvironment';

const managedInstallHomeKey = FIRST_PARTY_INSTALL_HOME_ENV_KEY;
const ambientEnvironmentKeys = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'TZ', managedInstallHomeKey, MANAGED_TOOLS_ROOT_ENV_KEY] as const;
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
  requiredFiles?: readonly string[];
  cwd: string;
  runtimeHome: string;
  environment: Readonly<Record<string, string | undefined>>;
  selectedEnvironmentKeys: readonly string[];
  providerEnvironmentKeys?: readonly string[];
  selectedMaterials: readonly AgentLaunchSelectedMaterial[];
  accountSettingsApplication?: import('./agentLaunchFrame').AgentLaunchAccountSettingsApplication;
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
    ...(input.accountSettingsApplication ? { accountSettingsApplication: input.accountSettingsApplication } : {}),
    environment: Object.fromEntries(Object.entries(input.environment)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    selectedMaterials: input.selectedMaterials.filter(file => file.relativePath !== SESSION_MCP_CONTEXT_RELATIVE_PATH),
  };
  const materialization = input.sessionMcpContext ? withSessionMcpAgentLaunchMaterial(selected, input.sessionMcpContext) : selected;
  // The native materialization owner decides availability once, before the
  // RunAs wrapper or Agent starts; host-readable temporary files are insufficient.
  if (input.requiredFiles?.length) {
    const selectedPaths = new Set(materialization.selectedMaterials.map(file => join(materialization.runtimeHome, file.relativePath)));
    if (input.requiredFiles.some(path => !selectedPaths.has(path))) throw new PluginError({
      code: 'agent_launch_required_file_unavailable',
      message: 'Required Agent extension or configuration was not materialized for the native launch',
      retryable: false, details: { phase: 'materialization', reason: 'not_materialized' },
    });
  }
  const environment: Record<string, string> = {};
  const selectedEnvironmentKeys = new Set(input.selectedEnvironmentKeys);
  const providerEnvironmentKeys = new Set(input.providerEnvironmentKeys);
  for (const key of new Set([...ambientEnvironmentKeys, ...input.selectedEnvironmentKeys, ...providerEnvironmentKeys, sessionContextFileKey])) {
    if (isSessionControlEnvKey(key)) continue;
    // Happier's custodian/control/Account context never becomes Agent authority.
    // The bridge reference names selected transient material; the public install
    // home is the canonical nonsecret layout input for Agent tools.
    if (key.startsWith('HAPPIER_') && !providerEnvironmentKeys.has(key) && key !== managedInstallHomeKey && key !== MANAGED_TOOLS_ROOT_ENV_KEY) {
      if (key === sessionContextFileKey) {
        if (!input.sessionMcpContext) continue;
      } else if (['HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE', 'HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE'].includes(key)) {
        if (!materialization.selectedMaterials.some(file => join(materialization.runtimeHome, file.relativePath) === materialization.environment[key])) continue;
      } else if (!selectedEnvironmentKeys.has(key)) continue;
    }
    // The published install location is machine-wide runtime code, independent
    // of the member HOME. Native finite operations do not select it as material.
    const value = materialization.environment[key]
      ?? (key === managedInstallHomeKey || key === MANAGED_TOOLS_ROOT_ENV_KEY ? process.env[key] : undefined);
    if (typeof value === 'string') environment[key] = value;
  }
  return {
    command: 'sudo',
    args: ['-n', '-u', member?.username ?? 'happier-agent', '--', input.managedHappierBinaryPath, 'agent-launch'],
    env: {},
    stdinPreamble: encodeAgentLaunchFrame({
      v: 1, executable: input.executable, args: input.args, cwd: input.cwd,
      runtimeHome: materialization.runtimeHome, environment, selectedMaterials: materialization.selectedMaterials,
      ...(materialization.accountSettingsApplication ? { accountSettingsApplication: materialization.accountSettingsApplication } : {}),
      ...(input.nativeSocketDirectory ? { nativeSocketDirectory: input.nativeSocketDirectory } : {}),
      ...(member ? { nativeIdentity: { username: member.username, agentUid: member.agentUid,
        agentGid: member.agentGid, home: member.home } } : {}),
    }),
  };
}
