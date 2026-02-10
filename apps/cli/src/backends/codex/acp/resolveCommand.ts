import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { delimiter as pathDelimiter } from 'node:path';

import { isCodexPermissionMode, type PermissionMode } from '@/api/types';
import { configuration } from '@/configuration';

export type SpawnSpec = { command: string; args: string[] };
export type ResolveCodexAcpSpawnOptions = { permissionMode?: PermissionMode };

function isTruthyEnv(value: string | undefined): boolean {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

type NpxMode = 'auto' | 'never' | 'force';

function readCodexAcpNpxMode(): NpxMode {
  const raw = typeof process.env.HAPPIER_CODEX_ACP_NPX_MODE === 'string'
    ? process.env.HAPPIER_CODEX_ACP_NPX_MODE.trim().toLowerCase()
    : '';
  if (raw === 'never' || raw === 'force' || raw === 'auto') return raw;

  // Backward-compat: legacy allow flag. (Default is already auto.)
  if (isTruthyEnv(process.env.HAPPIER_CODEX_ACP_ALLOW_NPX)) return 'auto';

  return 'auto';
}

function isCodexAcpOnPath(): boolean {
  const path = typeof process.env.PATH === 'string' ? process.env.PATH : '';
  if (!path) return false;
  const candidates = process.platform === 'win32'
    ? ['codex-acp.cmd', 'codex-acp.exe', 'codex-acp']
    : ['codex-acp'];

  for (const dir of path.split(pathDelimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of candidates) {
      try {
        if (existsSync(join(trimmed, name))) return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
}

function readCodexAcpConfigOverrides(): string[] {
  const raw =
    typeof process.env.HAPPIER_CODEX_ACP_CONFIG_OVERRIDES === 'string'
      ? process.env.HAPPIER_CODEX_ACP_CONFIG_OVERRIDES
      : typeof process.env.HAPPY_CODEX_ACP_CONFIG_OVERRIDES === 'string'
        ? process.env.HAPPY_CODEX_ACP_CONFIG_OVERRIDES
        : '';
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function appendConfigOverridesArgs(spec: SpawnSpec): SpawnSpec {
  const overrides = readCodexAcpConfigOverrides();
  if (overrides.length === 0) return spec;
  return {
    command: spec.command,
    args: [...spec.args, ...overrides.flatMap((o) => ['-c', o])],
  };
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
 * 2) Capability install under HAPPIER_HOME_DIR/tools/codex-acp
 * 3) PATH fallback (`codex-acp`) when available
 * 4) npx fallback (default) when not installed
 */
export function resolveCodexAcpSpawn(opts: ResolveCodexAcpSpawnOptions = {}): SpawnSpec {
  return resolveCodexAcpSpawnWithOptions(opts);
}

export function resolveCodexAcpSpawnWithOptions(opts: ResolveCodexAcpSpawnOptions = {}): SpawnSpec {
  const envOverride = typeof process.env.HAPPIER_CODEX_ACP_BIN === 'string'
    ? process.env.HAPPIER_CODEX_ACP_BIN.trim()
    : '';
  if (envOverride) {
    // Normalize to absolute so spawn works even when the provider changes cwd (e.g. session workspace).
    const resolved = isAbsolute(envOverride) ? envOverride : resolvePath(process.cwd(), envOverride);
    if (!existsSync(resolved)) {
      throw new Error(`Codex ACP is enabled but HAPPIER_CODEX_ACP_BIN does not exist: ${resolved}`);
    }
    return appendPermissionModeDerivedOverrides(appendConfigOverridesArgs({ command: resolved, args: [] }), opts);
  }

  const binName = process.platform === 'win32' ? 'codex-acp.cmd' : 'codex-acp';
  const defaultPath = join(configuration.happyHomeDir, 'tools', 'codex-acp', 'node_modules', '.bin', binName);
  if (existsSync(defaultPath)) {
    return appendPermissionModeDerivedOverrides(appendConfigOverridesArgs({ command: defaultPath, args: [] }), opts);
  }

  const npxMode = readCodexAcpNpxMode();
  if (npxMode === 'force') {
    return appendPermissionModeDerivedOverrides(
      appendConfigOverridesArgs({ command: 'npx', args: ['-y', '@zed-industries/codex-acp'] }),
      opts,
    );
  }

  if (npxMode === 'never') {
    return appendPermissionModeDerivedOverrides(appendConfigOverridesArgs({ command: 'codex-acp', args: [] }), opts);
  }

  // Default: prefer installed CLI on PATH when present; otherwise use npx.
  if (isCodexAcpOnPath()) {
    return appendPermissionModeDerivedOverrides(appendConfigOverridesArgs({ command: 'codex-acp', args: [] }), opts);
  }
  return appendPermissionModeDerivedOverrides(
    appendConfigOverridesArgs({ command: 'npx', args: ['-y', '@zed-industries/codex-acp'] }),
    opts,
  );
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
