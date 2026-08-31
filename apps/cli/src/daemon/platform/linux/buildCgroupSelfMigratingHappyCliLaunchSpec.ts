import { join, posix } from 'node:path';

import {
    buildHappyCliSubprocessLaunchSpec,
    type HappyCliSubprocessLaunchOptions,
    type HappyCliSubprocessLaunchSpec,
} from '@/utils/spawnHappyCLI';
import { resolveDaemonSessionScopeBaseRelativePath } from './resolveDaemonSessionScopeBaseRelativePath';
import {
    buildSystemdUserCriticalScopedLaunchSpec,
    isSystemdUserCriticalResourceGovernorReady,
    type SystemdUserResourceGovernorExecFile,
} from './systemdUserResourceGovernor';

function normalizePid(raw: unknown): number | null {
    return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

async function readUnifiedProcessCgroupRelativePath(
    pid: number,
    procfsRootDir: string,
): Promise<string | null> {
    try {
        const { readFile } = await import('node:fs/promises');
        const raw = await readFile(join(procfsRootDir, String(pid), 'cgroup'), 'utf8');
        for (const line of raw.split('\n')) {
            if (!line.startsWith('0::')) continue;
            const relativePath = line.slice('0::'.length).trim();
            return relativePath || null;
        }
        return null;
    } catch {
        return null;
    }
}

export type ExecutableLaunchSpec = Readonly<{
    filePath: string;
    args: string[];
    env?: Record<string, string>;
}>;

export async function buildCgroupSelfMigratingHappyCliLaunchSpec(params: Readonly<{
    args: string[];
    daemonPid?: number;
    procfsRootDir?: string;
    cgroupRootDir?: string;
    launchOptions?: HappyCliSubprocessLaunchOptions;
    environment?: NodeJS.ProcessEnv;
    systemdUserResourceGovernorExecFile?: SystemdUserResourceGovernorExecFile;
}>): Promise<ExecutableLaunchSpec | null> {
    const daemonPid = normalizePid(params.daemonPid) ?? process.pid;
    const procfsRootDir = params.procfsRootDir ?? '/proc';
    const cgroupRootDir = params.cgroupRootDir ?? '/sys/fs/cgroup';
    const baseLaunchSpec: HappyCliSubprocessLaunchSpec = buildHappyCliSubprocessLaunchSpec(params.args, params.launchOptions);
    const systemdUserCriticalResourceGovernorReady = await isSystemdUserCriticalResourceGovernorReady({
        environment: params.environment ?? process.env,
        execFile: params.systemdUserResourceGovernorExecFile,
    });
    if (systemdUserCriticalResourceGovernorReady) {
        return buildSystemdUserCriticalScopedLaunchSpec({
            launchSpec: {
                filePath: baseLaunchSpec.filePath,
                args: baseLaunchSpec.args,
                env: {
                    ...(baseLaunchSpec.env ?? {}),
                    // A systemd scope is the owner of this process tree. Do not let the
                    // legacy runner-side cgroup migration move the child out of it.
                    HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP: '',
                },
            },
        });
    }

    const daemonServiceRelativePath = await readUnifiedProcessCgroupRelativePath(daemonPid, procfsRootDir);
    if (!daemonServiceRelativePath) {
        return null;
    }

    const sessionScopeBaseRelativePath = resolveDaemonSessionScopeBaseRelativePath(daemonServiceRelativePath);
    if (!sessionScopeBaseRelativePath || sessionScopeBaseRelativePath === '.' || sessionScopeBaseRelativePath === daemonServiceRelativePath) {
        return null;
    }

    const appSliceAbsolutePath = join(cgroupRootDir, sessionScopeBaseRelativePath);

    return {
        filePath: '/bin/sh',
        args: [
            '-lc',
            'target_dir="$HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR/happier-session-$$.scope"; mkdir -p "$target_dir" 2>/dev/null || true; printf "%s\\n" "$$" > "$target_dir/cgroup.procs" 2>/dev/null || true; exec "$@"',
            'sh',
            baseLaunchSpec.filePath,
            ...baseLaunchSpec.args,
        ],
        env: {
            ...(baseLaunchSpec.env ?? {}),
            HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR: appSliceAbsolutePath,
        },
    };
}
