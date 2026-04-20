import * as os from 'node:os';

import { configuration } from '@/configuration';
import { isBun } from '@/utils/runtime';
import { resolveJavaScriptRuntimeExecutable } from '@/runtime/js/resolveJavaScriptRuntimeExecutable';
import { resolveDaemonServiceRuntimeTarget } from './runtimeTarget';
import { resolveLinuxSystemUserPaths } from './resolveLinuxSystemUserPaths';
import { inferPublicReleaseRingIdFromEnvAndArgv } from '@/cli/runtime/publicReleaseChannel';
import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import type { DaemonServiceMode, DaemonServiceTargetMode } from './plan';

import type { DaemonServiceCliRuntime, SupportedPlatform } from './cli';

export function resolveSupportedPlatform(p: string): SupportedPlatform | null {
  const normalized = (p ?? '').toString().trim().toLowerCase();
  if (normalized === 'darwin' || normalized === 'mac' || normalized === 'macos' || normalized === 'osx') return 'darwin';
  if (normalized === 'linux') return 'linux';
  if (normalized === 'win32' || normalized === 'windows' || normalized === 'win') return 'win32';
  return null;
}

export function resolvePlatformFromProcess(): SupportedPlatform | null {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'win32';
  return null;
}

export function resolveDaemonServiceTargetModeFromText(raw: string | null | undefined): DaemonServiceTargetMode {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === 'default-following' ? 'default-following' : 'pinned';
}

export function resolveDaemonServiceCliRuntimeFromEnv(options: Readonly<{
  mode?: DaemonServiceMode;
  systemUser?: string;
  channel?: PublicReleaseRingId | null;
  targetMode?: DaemonServiceTargetMode | null;
  instanceId?: string | null;
  processEnv?: NodeJS.ProcessEnv;
}> = {}): DaemonServiceCliRuntime {
  const processEnv = options.processEnv ?? process.env;
  const platform =
    resolveSupportedPlatform(processEnv.HAPPIER_DAEMON_SERVICE_PLATFORM ?? '') ??
    resolvePlatformFromProcess();
  if (!platform) {
    throw new Error('Background service management is currently only supported on macOS, Linux, and Windows');
  }

  const uidEnvRaw = (processEnv.HAPPIER_DAEMON_SERVICE_UID ?? '').trim();
  const uidEnv = uidEnvRaw ? Number(uidEnvRaw) : null;
  const uidFromProc = process.getuid ? process.getuid() : null;
  const uid = uidEnv !== null && Number.isFinite(uidEnv) && uidEnv >= 0 ? uidEnv : uidFromProc;

  const explicitUserHomeDir = expandHomeDirPath((processEnv.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR ?? '').trim(), processEnv);
  const explicitHappierHomeDir = expandHomeDirPath((processEnv.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR ?? '').trim(), processEnv);
  const systemUserPaths =
    platform === 'linux' && options.mode === 'system' && String(options.systemUser ?? '').trim()
      ? resolveLinuxSystemUserPaths({
        systemUser: String(options.systemUser ?? '').trim(),
        userHomeDirOverride: explicitUserHomeDir,
        happierHomeDirOverride: explicitHappierHomeDir,
      })
      : null;
  const sudoInvokerUserPaths =
    platform === 'linux'
      && options.mode !== 'system'
      && !explicitUserHomeDir
      && uid === 0
      && String(processEnv.SUDO_USER ?? '').trim()
      ? (() => {
        try {
          return resolveLinuxSystemUserPaths({
            systemUser: String(processEnv.SUDO_USER ?? '').trim(),
          });
        } catch {
          return null;
        }
      })()
      : null;

  let resolvedRealHomeDir = '';
  try {
    resolvedRealHomeDir = String(os.userInfo()?.homedir ?? '').trim();
  } catch {
    resolvedRealHomeDir = '';
  }
  const userHomeDir = systemUserPaths?.userHomeDir
    || explicitUserHomeDir
    || sudoInvokerUserPaths?.userHomeDir
    || resolvedRealHomeDir
    || os.homedir();
  const shouldPreferSudoInvokerHappierHomeDir =
    platform === 'linux'
    && options.mode !== 'system'
    && uid === 0
    && Boolean(sudoInvokerUserPaths?.happierHomeDir)
    && !explicitHappierHomeDir
    && !String(processEnv.HAPPIER_HOME_DIR ?? '').trim();
  const happierHomeDir = systemUserPaths?.happierHomeDir
    || explicitHappierHomeDir
    || (shouldPreferSudoInvokerHappierHomeDir ? sudoInvokerUserPaths?.happierHomeDir : null)
    || configuration.happyHomeDir;
  const targetMode = options.targetMode ?? resolveDaemonServiceTargetModeFromText(processEnv.HAPPIER_DAEMON_SERVICE_TARGET_MODE);
  const instanceId = String(options.instanceId ?? '').trim() || (processEnv.HAPPIER_DAEMON_SERVICE_INSTANCE_ID ?? '').trim() || configuration.activeServerId;
  const serverUrl = (processEnv.HAPPIER_DAEMON_SERVICE_SERVER_URL ?? '').trim() || configuration.serverUrl;
  const webappUrl = (processEnv.HAPPIER_DAEMON_SERVICE_WEBAPP_URL ?? '').trim() || configuration.webappUrl;
  const publicServerUrl = (processEnv.HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL ?? '').trim() || configuration.publicServerUrl;
  const explicitNodePath = (processEnv.HAPPIER_DAEMON_SERVICE_NODE_PATH ?? '').trim();
  const explicitEntryPath = (processEnv.HAPPIER_DAEMON_SERVICE_ENTRY_PATH ?? '').trim();
  const runtimeTarget = resolveDaemonServiceRuntimeTarget({
    currentExecPath: process.execPath,
    runtimeExecutable: explicitNodePath
      ? null
      : resolveJavaScriptRuntimeExecutable({
        isBunRuntime: isBun(),
        processEnv,
      }),
    explicitNodePath,
    explicitEntryPath,
  });
  const channel = options.channel
    || normalizePublicReleaseRingId(String(processEnv.HAPPIER_DAEMON_SERVICE_CHANNEL ?? '').trim())
    || inferPublicReleaseRingIdFromEnvAndArgv({
      env: processEnv,
      argv: process.argv,
      additionalCandidates: [
        explicitEntryPath,
        runtimeTarget.entryPath,
        runtimeTarget.nodePath,
      ],
    });

  return {
    platform,
    channel,
    targetMode,
    instanceId,
    uid,
    userHomeDir,
    happierHomeDir,
    serverUrl,
    webappUrl,
    publicServerUrl,
    nodePath: runtimeTarget.nodePath,
    entryPath: runtimeTarget.entryPath,
  };
}
