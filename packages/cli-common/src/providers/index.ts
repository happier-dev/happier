import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentId, ProviderCliInstallPlatform, ProviderCliInstallSpec } from '@happier-dev/agents';
import { getProviderCliInstallSpec } from '@happier-dev/agents';

export type ProviderCliInstallPlan = Readonly<{
  providerId: AgentId;
  title: string;
  binaries: ReadonlyArray<string>;
  platform: ProviderCliInstallPlatform;
  docsUrl: string | null;
  commands: ReadonlyArray<Readonly<{ cmd: string; args: ReadonlyArray<string>; requiresAdmin: boolean; note: string | null }>>;
  requiresAdmin: boolean;
}>;

export type ProviderCliInstallPlanResult =
  | Readonly<{ ok: true; plan: ProviderCliInstallPlan; spec: ProviderCliInstallSpec }>
  | Readonly<{ ok: false; errorMessage: string; spec: ProviderCliInstallSpec }>;

export function resolvePlatformFromNodePlatform(nodePlatform: string): ProviderCliInstallPlatform | null {
  if (nodePlatform === 'darwin') return 'darwin';
  if (nodePlatform === 'linux') return 'linux';
  if (nodePlatform === 'win32') return 'win32';
  return null;
}

function commandExists(cmd: string, env: NodeJS.ProcessEnv): boolean {
  const name = String(cmd ?? '').trim();
  if (!name) return false;

  const pathEnv = env.PATH ?? process.env.PATH;
  if (process.platform === 'win32') {
    const res = spawnSync('where', [name], { stdio: 'ignore', env: { ...process.env, ...env, PATH: pathEnv } });
    return (res.status ?? 1) === 0;
  }
  const res = spawnSync('sh', ['-lc', `command -v ${name} >/dev/null 2>&1`], { stdio: 'ignore', env: { ...process.env, ...env, PATH: pathEnv } });
  return (res.status ?? 1) === 0;
}

function resolveProviderInstallCommands(spec: ProviderCliInstallSpec, platform: ProviderCliInstallPlatform) {
  const commandsRaw = spec.install?.[platform] ?? null;
  if (!commandsRaw || commandsRaw.length === 0) return null;
  return commandsRaw.map((c) => ({
    cmd: c.cmd,
    args: [...c.args],
    requiresAdmin: Boolean(c.requiresAdmin),
    note: typeof c.note === 'string' ? c.note : null,
  }));
}

export function planProviderCliInstall(params: Readonly<{ providerId: AgentId; platform: ProviderCliInstallPlatform }>): ProviderCliInstallPlanResult {
  const spec = getProviderCliInstallSpec(params.providerId);
  const commands = resolveProviderInstallCommands(spec, params.platform);
  if (!commands) {
    return { ok: false, spec, errorMessage: `No auto-install recipe available for ${spec.id} on ${params.platform}.` };
  }

  const requiresAdmin = commands.some((c) => c.requiresAdmin);
  return {
    ok: true,
    spec,
    plan: {
      providerId: spec.id,
      title: spec.title,
      binaries: spec.binaries,
      platform: params.platform,
      docsUrl: typeof spec.docsUrl === 'string' ? spec.docsUrl : null,
      commands,
      requiresAdmin,
    },
  };
}

function resolveLogPath(params: Readonly<{ providerId: AgentId; logDir?: string | null }>): string {
  const base = typeof params.logDir === 'string' && params.logDir.trim() ? params.logDir.trim() : join(tmpdir(), 'happier-provider-installs');
  mkdirSync(base, { recursive: true });
  return join(base, `install-provider-${params.providerId}-${Date.now()}.log`);
}

function writeLogHeader(logPath: string, plan: ProviderCliInstallPlan): void {
  writeFileSync(
    logPath,
    [
      `# providerId: ${plan.providerId}`,
      `# platform: ${plan.platform}`,
      `# requiresAdmin: ${plan.requiresAdmin ? '1' : '0'}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

function appendCommandLog(logPath: string, cmd: string, args: readonly string[], stdout: string, stderr: string, status: number | null): void {
  appendFileSync(
    logPath,
    [
      '',
      `## ${cmd} ${args.join(' ')}`.trim(),
      `# exit: ${status ?? 'null'}`,
      '',
      '### stdout',
      stdout || '',
      '',
      '### stderr',
      stderr || '',
      '',
    ].join('\n'),
    'utf8',
  );
}

export type InstallProviderCliResult =
  | Readonly<{ ok: true; plan: ProviderCliInstallPlan; alreadyInstalled: boolean; logPath: string | null }>
  | Readonly<{ ok: false; errorMessage: string; plan: ProviderCliInstallPlan | null; logPath: string | null }>;

export function installProviderCli(params: Readonly<{
  providerId: AgentId;
  platform: ProviderCliInstallPlatform;
  env?: NodeJS.ProcessEnv;
  logDir?: string | null;
  dryRun?: boolean;
  skipIfInstalled?: boolean;
}>): InstallProviderCliResult {
  const env = params.env ?? process.env;
  const skipIfInstalled = params.skipIfInstalled !== false;

  const planned = planProviderCliInstall({ providerId: params.providerId, platform: params.platform });
  if (!planned.ok) {
    return { ok: false, errorMessage: planned.errorMessage, plan: null, logPath: null };
  }

  const plan = planned.plan;

  if (skipIfInstalled) {
    const allPresent = plan.binaries.every((b) => commandExists(b, env));
    if (allPresent) {
      return { ok: true, plan, alreadyInstalled: true, logPath: null };
    }
  }

  if (params.dryRun) {
    return { ok: true, plan, alreadyInstalled: false, logPath: null };
  }

  const logPath = resolveLogPath({ providerId: params.providerId, logDir: params.logDir });
  writeLogHeader(logPath, plan);

  for (const c of plan.commands) {
    if (!commandExists(c.cmd, env)) {
      return { ok: false, errorMessage: `Command not found: ${c.cmd}`, plan, logPath };
    }
    const res = spawnSync(c.cmd, [...c.args], { encoding: 'utf8', env: { ...process.env, ...env } });
    if (res.error) {
      appendCommandLog(logPath, c.cmd, c.args, '', res.error.message, res.status ?? null);
      return { ok: false, errorMessage: res.error.message, plan, logPath };
    }
    const status = typeof res.status === 'number' ? res.status : null;
    appendCommandLog(logPath, c.cmd, c.args, String(res.stdout ?? ''), String(res.stderr ?? ''), status);
    if (status !== 0) {
      const stderr = String(res.stderr ?? '').trim();
      return { ok: false, errorMessage: stderr || `Command failed (${status ?? 'unknown'}): ${c.cmd}`, plan, logPath };
    }
  }

  return { ok: true, plan, alreadyInstalled: false, logPath };
}

