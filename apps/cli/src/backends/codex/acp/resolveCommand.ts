import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { delimiter as pathDelimiter } from 'node:path';

import { isCodexPermissionMode, type PermissionMode } from '@/api/types';
import { resolveExistingCodexAcpManagedBinPath } from '@/capabilities/deps/codexAcp';
import { appendCodexCliConfigOverridesArgs } from '../utils/appendCodexCliConfigOverridesArgs';

export type SpawnSpec = { command: string; args: string[] };
export type ResolveCodexAcpSpawnOptions = {
  permissionMode?: PermissionMode;
  disableUserMcpServers?: boolean;
  env?: NodeJS.ProcessEnv;
  currentWorkingDirectory?: string;
};

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
        if (existsSync(candidatePath) && isRunnableCodexAcpPath(candidatePath)) return true;
      } catch {
        // ignore
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
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
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

function appendConfigOverridesArgs(spec: SpawnSpec, opts: ResolveCodexAcpSpawnOptions): SpawnSpec {
  const env = opts.env ?? process.env;
  // Probe-style Codex ACP spawns should not inherit arbitrary user-configured MCP servers.
  // Codex can block responding to `loadSession` while it attempts to start all configured MCP servers,
  // which makes capability probing and resume checks unreliable.
  //
  // Live Codex ACP sessions preserve user MCP configuration by default so provider features like
  // thought streaming remain available. Callers can still opt out explicitly for probe-like spawns.
  const baseOverrides: string[] = opts.disableUserMcpServers === true
    ? readCodexMcpServerKeysFromConfigToml(env).map((key) => `mcp_servers.${key}.enabled=false`)
    : [];

  const overrides = readCodexAcpConfigOverrides(env);
  return appendCodexCliConfigOverridesArgs(spec, [...baseOverrides, ...overrides]);
}

/**
 * Resolve the Codex ACP binary.
 *
 * Codex ACP is provided by the optional `codex-acp` capability install.
 */
export function resolveCodexAcpCommand(): string {
  return resolveCodexAcpSpawn().command;
}

/**
 * Resolve the Codex ACP spawn spec (command + args).
 *
 * Order:
 * 1) Explicit env override: HAPPIER_CODEX_ACP_BIN
 * 2) Managed codex-acp install under HAPPIER_HOME_DIR/tools/codex-acp/current/bin
 * 3) PATH fallback (`codex-acp`) when available
 * 4) PATH fallback (`codex-acp`)
 */
export function resolveCodexAcpSpawn(opts: ResolveCodexAcpSpawnOptions = {}): SpawnSpec {
  return resolveCodexAcpSpawnWithOptions(opts);
}

export function resolveCodexAcpSpawnWithOptions(opts: ResolveCodexAcpSpawnOptions = {}): SpawnSpec {
  const env = opts.env ?? process.env;
  const currentWorkingDirectory = opts.currentWorkingDirectory ?? process.cwd();
  const envOverride = typeof env.HAPPIER_CODEX_ACP_BIN === 'string'
    ? env.HAPPIER_CODEX_ACP_BIN.trim()
    : '';
  if (envOverride) {
    // Normalize to absolute so spawn works even when the provider changes cwd (e.g. session workspace).
    const resolved = isAbsolute(envOverride) ? envOverride : resolvePath(currentWorkingDirectory, envOverride);
    if (!existsSync(resolved)) {
      throw new Error(`Codex ACP is enabled but HAPPIER_CODEX_ACP_BIN does not exist: ${resolved}`);
    }
    if (!isRunnableCodexAcpPath(resolved)) {
      throw new Error(`Codex ACP is enabled but HAPPIER_CODEX_ACP_BIN is not executable: ${resolved}`);
    }
    return appendPermissionModeDerivedOverrides(appendConfigOverridesArgs({ command: resolved, args: [] }, opts), opts);
  }

  const managedPath = resolveExistingCodexAcpManagedBinPath(env);
  if (managedPath) {
    return appendPermissionModeDerivedOverrides(appendConfigOverridesArgs({ command: managedPath, args: [] }, opts), opts);
  }

  // Default: prefer user-installed CLI on PATH and surface an unavailable spawn if nothing resolves.
  if (isCodexAcpOnPath(env)) {
    return appendPermissionModeDerivedOverrides(appendConfigOverridesArgs({ command: 'codex-acp', args: [] }, opts), opts);
  }
  return appendPermissionModeDerivedOverrides(appendConfigOverridesArgs({ command: 'codex-acp', args: [] }, opts), opts);
}

function appendPermissionModeDerivedOverrides(spec: SpawnSpec, opts: ResolveCodexAcpSpawnOptions): SpawnSpec {
  const mode = opts.permissionMode;
  if (!mode) return spec;
  if (!isCodexPermissionMode(mode) && mode !== 'plan') return spec;

	  const derivedByMode: Readonly<Partial<Record<string, readonly string[]>>> = {
	    yolo: ['approval_policy="never"', 'sandbox_mode="danger-full-access"'],
	    bypassPermissions: ['approval_policy="never"', 'sandbox_mode="danger-full-access"'],
	    // Force Codex ACP to route tool approvals through ACP permission prompts so Happier can
	    // apply its permission-mode policy (e.g. safe-yolo auto-approves reads, read-only denies writes).
	    //
	    // Note: "untrusted" can be trust-level dependent in Codex; "on-request" is the stable "always ask" policy.
	    'safe-yolo': ['approval_policy="on-request"', 'sandbox_mode="workspace-write"'],
	    'read-only': ['approval_policy="on-request"', 'sandbox_mode="read-only"'],
	    // Default/plan: keep prompts enabled and run in a read-only sandbox by default.
	    default: ['approval_policy="on-request"', 'sandbox_mode="read-only"'],
	    plan: ['approval_policy="on-request"', 'sandbox_mode="read-only"'],
	  };
  const derived = derivedByMode[mode] ?? null;

  if (!derived) return spec;

  // Append after env-derived overrides so explicit mode selections win.
  return { command: spec.command, args: [...spec.args, ...derived.flatMap((o) => ['-c', o])] };
}
