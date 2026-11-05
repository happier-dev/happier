import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

import { buildHappyCliSubprocessLaunchSpec, type HappyCliSubprocessLaunchOptions, type HappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import { resolveDaemonSessionScopeBaseRelativePath } from './resolveDaemonSessionScopeBaseRelativePath';
import { readUnifiedProcessCgroupRelativePath } from './readUnifiedProcessCgroupRelativePath';
import { configuration } from '@/configuration';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import {
  buildSystemdUserScopedLaunchSpec,
  isSystemdUserResourceGovernorReady,
  supportsSystemdRunEnvironmentExpansionOption,
  type SystemdUserResourceGovernorExecFile,
  buildSessionScopeExitLaunchSpec, sessionScopeExitEvidencePath, type SessionScopeExitCapture,
} from './systemdUserResourceGovernor';

function normalizePid(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

export type ExecutableLaunchSpec = Readonly<{
  filePath: string;
  args: string[];
  env?: Record<string, string>;
  /** Exact physical scope basename selected by this launch composer. */
  linuxLaunchUnit?: string;
}>;

export type LinuxProcessLaunchScope =
  | Readonly<{ kind: 'systemd'; systemdRunPath: string; transportEnvironment: Record<string, string>; supportsEnvironmentExpansionOption: boolean }>
  | Readonly<{ kind: 'cgroup'; baseDir: string }>;

export async function prepareCgroupProcessLaunchScope(params: Readonly<{
  daemonPid?: number;
  procfsRootDir?: string;
  cgroupRootDir?: string;
  environment?: NodeJS.ProcessEnv;
  systemdUserResourceGovernorExecFile?: SystemdUserResourceGovernorExecFile;
}> = {}): Promise<LinuxProcessLaunchScope | null> {
  const environment = params.environment ?? process.env;
  if (await isSystemdUserResourceGovernorReady({
    environment,
    execFile: params.systemdUserResourceGovernorExecFile,
  })) {
    // Resolve using the host's PATH, not the admitted target's possibly empty PATH.
    for (const directory of (environment.PATH ?? process.env.PATH ?? '').split(':')) {
      const systemdRunPath = resolve(directory, 'systemd-run');
      try {
        await access(systemdRunPath, constants.X_OK);
        if (!(await stat(systemdRunPath)).isFile()) continue;
        const supportsEnvironmentExpansionOption = await supportsSystemdRunEnvironmentExpansionOption({
          systemdRunPath, environment, execFile: params.systemdUserResourceGovernorExecFile,
        });
        if (supportsEnvironmentExpansionOption === null) continue;
        const transportEnvironment: Record<string, string> = {};
        for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) {
          if (environment[key] !== undefined) transportEnvironment[key] = environment[key]!;
        }
        return { kind: 'systemd', systemdRunPath, transportEnvironment, supportsEnvironmentExpansionOption };
      } catch {}
    }
  }
  const daemonPath = await readUnifiedProcessCgroupRelativePath(normalizePid(params.daemonPid) ?? process.pid, params.procfsRootDir ?? '/proc');
  if (!daemonPath) return null;
  const base = resolveDaemonSessionScopeBaseRelativePath(daemonPath);
  if (!base || base === '.' || base === daemonPath) return null;
  return { kind: 'cgroup', baseDir: join(params.cgroupRootDir ?? '/sys/fs/cgroup', base) };
}

/** The prepared OS context also serves synchronous PTY/native spawn boundaries. */
export function buildCgroupProcessLaunchSpec(params: Readonly<{
  launchSpec: ExecutableLaunchSpec;
  unit?: string;
  scope: LinuxProcessLaunchScope;
  memoryHighBytes?: number | null;
  sessionExitCapture?: SessionScopeExitCapture;
}>): ExecutableLaunchSpec {
  const baseLaunchSpec = params.launchSpec;
  if (params.scope.kind === 'systemd') {
    const targetEnvironment: Record<string, string> = { ...baseLaunchSpec.env, HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP: '' };
    const launchEnvironment = { ...targetEnvironment, ...params.scope.transportEnvironment };
    const restoreTargetEnvironment: string[] = [];
    for (const [key, value] of Object.entries(params.scope.transportEnvironment)) {
      if (targetEnvironment[key] === value) continue;
      if (targetEnvironment[key] === undefined) restoreTargetEnvironment.push(`unset ${key};`);
      else {
        // Keep target values in the environment, never in the helper's argv.
        const targetKey = `HAPPIER_DAEMON_SCOPE_TARGET_${key}`;
        launchEnvironment[targetKey] = targetEnvironment[key]!;
        restoreTargetEnvironment.push(`${key}="$${targetKey}"; export ${key}; unset ${targetKey};`);
      }
    }
    const scoped = buildSystemdUserScopedLaunchSpec({
      unit: params.unit,
      sessionExitCapture: params.sessionExitCapture,
      ...(params.memoryHighBytes === undefined || params.memoryHighBytes === null ? {} : {
        properties: ['MemoryAccounting=yes', `MemoryHigh=${params.memoryHighBytes}`],
      }),
      ...(params.scope.supportsEnvironmentExpansionOption ? { expandEnvironment: false } : {}),
      launchSpec: {
        ...baseLaunchSpec,
        ...(restoreTargetEnvironment.length ? {
          filePath: '/bin/sh',
          args: ['-c', `${restoreTargetEnvironment.join(' ')} exec "$@"`, 'sh', baseLaunchSpec.filePath, ...baseLaunchSpec.args],
        } : {}),
        env: launchEnvironment,
      },
    });
    return { ...scoped, filePath: params.scope.systemdRunPath,
      ...(params.unit ? { linuxLaunchUnit: params.unit } : {}),
    };
  }
  const unit = params.unit ?? `happier-session-${randomUUID().replaceAll('-', '')}.scope`;
  const targetSpec = params.sessionExitCapture
    ? buildSessionScopeExitLaunchSpec({ launchSpec: baseLaunchSpec, unit, capture: params.sessionExitCapture }) : baseLaunchSpec;
  const requiresScope = params.memoryHighBytes !== undefined && params.memoryHighBytes !== null;
  return {
    filePath: '/bin/sh',
    linuxLaunchUnit: unit,
    args: [
      '-c',
      'target_dir="$HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR/$HAPPIER_DAEMON_PROCESS_CGROUP_UNIT"; if mkdir -p "$target_dir"'
        + (requiresScope ? '' : ' 2>/dev/null') + '; then '
        + (requiresScope ? 'printf "%s\\n" "$HAPPIER_DAEMON_SESSION_MEMORY_HIGH_BYTES" > "$target_dir/memory.high" || exit; ' : '')
        + 'printf "%s\\n" "$$" > "$target_dir/cgroup.procs" 2>/dev/null || '
        + (requiresScope ? 'exit' : 'true')
        + '; ' + (requiresScope ? 'else exit; ' : '')
        + 'fi; exec "$@"',
      'sh', targetSpec.filePath, ...targetSpec.args,
    ],
    env: {
      ...baseLaunchSpec.env,
      HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR: params.scope.baseDir,
      HAPPIER_DAEMON_PROCESS_CGROUP_UNIT: unit,
      HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP: '',
      ...(requiresScope ? { HAPPIER_DAEMON_SESSION_MEMORY_HIGH_BYTES: String(params.memoryHighBytes) } : {}),
    },
  };
}

export async function buildCgroupSelfMigratingHappyCliLaunchSpec(params: Readonly<{
  daemonPid?: number;
  procfsRootDir?: string;
  cgroupRootDir?: string;
  environment?: NodeJS.ProcessEnv;
  systemdUserResourceGovernorExecFile?: SystemdUserResourceGovernorExecFile;
  unit?: string;
  memoryHighBytes?: number | null;
} & (
  | { args: string[]; launchOptions?: HappyCliSubprocessLaunchOptions; launchSpec?: never }
  | { launchSpec: HappyCliSubprocessLaunchSpec; args?: never; launchOptions?: never }
)>): Promise<ExecutableLaunchSpec | null> {
  const baseLaunchSpec = params.launchSpec ?? buildHappyCliSubprocessLaunchSpec(params.args, params.launchOptions);
  const scope = await prepareCgroupProcessLaunchScope(params);
  if (!scope) return null;
  const unit = params.unit ?? `happier-session-${randomUUID().replaceAll('-', '')}.scope`;
  const executable = process.platform === 'linux' ? resolveProcessCustodySupportExecutable('linux') : null;
  if (process.platform === 'linux' && !executable) throw new Error('Session scope exit helper unavailable');
  return buildCgroupProcessLaunchSpec({ launchSpec: baseLaunchSpec, unit, scope, memoryHighBytes: params.memoryHighBytes,
    ...(executable ? { sessionExitCapture: { executable, evidencePath: sessionScopeExitEvidencePath(configuration.activeServerDir, unit) } } : {}),
  });
}
