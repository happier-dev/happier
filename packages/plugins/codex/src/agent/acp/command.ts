import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter as pathDelimiter, isAbsolute, join, resolve as resolvePath } from 'node:path';

export type CodexAcpSpawnSpec = { command: string; args: string[] };

export type ResolveCodexAcpSpawnOptions = Readonly<{
  permissionMode?: string;
  disableUserMcpServers?: boolean;
  env?: NodeJS.ProcessEnv;
  currentWorkingDirectory?: string;
}>;

export type ResolveCodexAcpSpawnDeps = Readonly<{
  resolveExistingManagedBinPath?: (env: NodeJS.ProcessEnv) => string | null;
}>;

function isRunnableCodexAcpPath(candidatePath: string): boolean {
  try {
    accessSync(candidatePath, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isCodexAcpOnPath(env: NodeJS.ProcessEnv): boolean {
  const path = typeof env.PATH === 'string' ? env.PATH : '';
  if (!path) return false;
  const candidates = process.platform === 'win32'
    ? ['codex-acp.cmd', 'codex-acp.exe', 'codex-acp']
    : ['codex-acp'];

  for (const dir of path.split(pathDelimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of candidates) {
      try {
        const candidatePath = join(trimmed, name);
        if (existsSync(candidatePath) && isRunnableCodexAcpPath(candidatePath)) {
          return true;
        }
      } catch {
        // Ignore malformed PATH entries.
      }
    }
  }
  return false;
}

function readCodexAcpConfigOverrides(env: NodeJS.ProcessEnv): string[] {
  const raw =
    typeof env.HAPPIER_CODEX_ACP_CONFIG_OVERRIDES === 'string'
      ? env.HAPPIER_CODEX_ACP_CONFIG_OVERRIDES
      : '';
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function resolveCodexConfigTomlPath(env: NodeJS.ProcessEnv): string {
  const codexHome = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  if (codexHome) return join(codexHome, 'config.toml');
  return join(homedir(), '.codex', 'config.toml');
}

function normalizeCodexMcpServerKeyFromConfigSection(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const firstChar = trimmed[0];
  if (firstChar === '"' || firstChar === "'") {
    const end = trimmed.indexOf(firstChar, 1);
    if (end === -1) return null;
    return trimmed.slice(0, end + 1);
  }

  const firstSegment = trimmed.split('.')[0]?.trim() ?? '';
  return firstSegment ? firstSegment : null;
}

function readCodexMcpServerKeysFromConfigToml(env: NodeJS.ProcessEnv): string[] {
  const configPath = resolveCodexConfigTomlPath(env);
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    return [];
  }

  const keys = new Set<string>();
  const re = /^\s*\[mcp_servers\.([^\]]+)\]\s*$/gm;
  for (;;) {
    const match = re.exec(text);
    if (!match) break;
    const key = normalizeCodexMcpServerKeyFromConfigSection(match[1] ?? '');
    if (!key) continue;
    keys.add(key);
  }

  return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

function appendConfigOverridesArgs(
  spec: CodexAcpSpawnSpec,
  opts: ResolveCodexAcpSpawnOptions,
): CodexAcpSpawnSpec {
  const env = opts.env ?? process.env;
  const baseOverrides: string[] = opts.disableUserMcpServers === true
    ? readCodexMcpServerKeysFromConfigToml(env).map((key) => `mcp_servers.${key}.enabled=false`)
    : [];

  const overrides = readCodexAcpConfigOverrides(env);
  const args = [...spec.args];
  for (const override of [...baseOverrides, ...overrides]) {
    args.push('-c', override);
  }
  return { command: spec.command, args };
}

function appendPermissionModeDerivedOverrides(
  spec: CodexAcpSpawnSpec,
  opts: ResolveCodexAcpSpawnOptions,
): CodexAcpSpawnSpec {
  const mode = opts.permissionMode;
  if (!mode) return spec;

  const derivedByMode: Readonly<Partial<Record<string, readonly string[]>>> = {
    yolo: ['approval_policy="never"', 'sandbox_mode="danger-full-access"'],
    bypassPermissions: ['approval_policy="never"', 'sandbox_mode="danger-full-access"'],
    'safe-yolo': ['approval_policy="on-request"', 'sandbox_mode="workspace-write"'],
    'read-only': ['approval_policy="on-request"', 'sandbox_mode="read-only"'],
    default: ['approval_policy="on-request"', 'sandbox_mode="read-only"'],
    plan: ['approval_policy="on-request"', 'sandbox_mode="read-only"'],
  };
  const derived = derivedByMode[mode] ?? null;

  if (!derived) return spec;
  return { command: spec.command, args: [...spec.args, ...derived.flatMap((entry) => ['-c', entry])] };
}

export function resolveCodexAcpSpawnWithOptions(
  opts: ResolveCodexAcpSpawnOptions = {},
  deps: ResolveCodexAcpSpawnDeps = {},
): CodexAcpSpawnSpec {
  const env = opts.env ?? process.env;
  const currentWorkingDirectory = opts.currentWorkingDirectory ?? process.cwd();
  const envOverride = typeof env.HAPPIER_CODEX_ACP_BIN === 'string'
    ? env.HAPPIER_CODEX_ACP_BIN.trim()
    : '';
  if (envOverride) {
    const resolved = isAbsolute(envOverride) ? envOverride : resolvePath(currentWorkingDirectory, envOverride);
    if (!existsSync(resolved)) {
      throw new Error(`Codex ACP is enabled but HAPPIER_CODEX_ACP_BIN does not exist: ${resolved}`);
    }
    if (!isRunnableCodexAcpPath(resolved)) {
      throw new Error(`Codex ACP is enabled but HAPPIER_CODEX_ACP_BIN is not executable: ${resolved}`);
    }
    return appendPermissionModeDerivedOverrides(appendConfigOverridesArgs({ command: resolved, args: [] }, opts), opts);
  }

  const managedPath = deps.resolveExistingManagedBinPath?.(env) ?? null;
  if (managedPath) {
    return appendPermissionModeDerivedOverrides(appendConfigOverridesArgs({ command: managedPath, args: [] }, opts), opts);
  }

  if (isCodexAcpOnPath(env)) {
    return appendPermissionModeDerivedOverrides(appendConfigOverridesArgs({ command: 'codex-acp', args: [] }, opts), opts);
  }
  return appendPermissionModeDerivedOverrides(appendConfigOverridesArgs({ command: 'codex-acp', args: [] }, opts), opts);
}
