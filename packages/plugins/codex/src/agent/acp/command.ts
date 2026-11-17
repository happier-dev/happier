import { resolveManagedDependencyCommand } from '@happier-dev/plugin-sdk/managed-services/native';
import { CODEX_ACP_MANAGED_DEPENDENCY } from '../installables/definition.js';
import { readCodexMcpServerKeysFromConfigToml } from '../mcp/configServers.js';
import { codexNativeUpstreamConfigOverrides } from '../providerBinding/runtimeConfig.js';
import { resolveCodexTerminalPermissionPolicy } from '../runtime/terminal/permissionPolicy.js';

export type CodexAcpSpawnSpec = { command: string; args: string[] };

export type ResolveCodexAcpSpawnOptions = Readonly<{
  permissionMode?: string;
  workspaceWrites?: 'allow' | 'deny';
  nativeSandbox?: 'on' | 'off';
  disableUserMcpServers?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  currentWorkingDirectory?: string;
}>;

export type ResolveCodexAcpSpawnDeps = Readonly<{
  resolveExistingManagedBinPath?: (env: Readonly<Record<string, string | undefined>>) => string | null;
}>;

function appendConfigOverridesArgs(
  spec: CodexAcpSpawnSpec,
  opts: ResolveCodexAcpSpawnOptions,
): CodexAcpSpawnSpec {
  const env = opts.env ?? process.env;
  const baseOverrides: string[] = opts.disableUserMcpServers === true
    ? readCodexMcpServerKeysFromConfigToml(env).map((key) => `mcp_servers.${key}.enabled=false`)
    : [];

  const args = [...[...baseOverrides, ...codexNativeUpstreamConfigOverrides(env)].flatMap((override) => ['-c', override]), ...spec.args];
  return { command: spec.command, args };
}

function appendPermissionModeDerivedOverrides(
  spec: CodexAcpSpawnSpec,
  opts: ResolveCodexAcpSpawnOptions,
): CodexAcpSpawnSpec {
  const mode = opts.permissionMode;
  if (!mode && opts.nativeSandbox === undefined && opts.workspaceWrites !== 'deny') return spec;

  const policy = resolveCodexTerminalPermissionPolicy(
    mode ?? 'default', opts.workspaceWrites, undefined, opts.nativeSandbox,
  );
  const derived = [
    `approval_policy=${JSON.stringify(policy.approvalPolicy)}`,
    `sandbox_mode=${JSON.stringify(policy.sandbox)}`,
  ];
  return { command: spec.command, args: [...spec.args, ...derived.flatMap((entry) => ['-c', entry])] };
}

export function resolveCodexAcpSpawnWithOptions(
  opts: ResolveCodexAcpSpawnOptions = {},
  deps: ResolveCodexAcpSpawnDeps = {},
): CodexAcpSpawnSpec {
  const env = opts.env ?? process.env;
  const spec = resolveManagedDependencyCommand({
    binaryName: CODEX_ACP_MANAGED_DEPENDENCY.executable,
    displayName: CODEX_ACP_MANAGED_DEPENDENCY.title,
    declaration: CODEX_ACP_MANAGED_DEPENDENCY.sources[0].launch,
    env,
    currentWorkingDirectory: opts.currentWorkingDirectory,
    resolveExistingManagedBinPath: deps.resolveExistingManagedBinPath,
  });
  return appendPermissionModeDerivedOverrides(appendConfigOverridesArgs({ command: spec.command, args: [...spec.args] }, opts), opts);
}
