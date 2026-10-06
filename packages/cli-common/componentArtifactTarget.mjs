import { spawnSync } from 'node:child_process';

/**
 * Bun and server sidecar acquisition use explicit OS/CPU targets. Only a
 * selected daemon adds the native support closure's host/toolchain constraint.
 * Placement and worker admission must make the same component-aware decision.
 */
export function getComponentArtifactBuildTargetUnavailableReason({ components, ...targetInputs }) {
  if (!components.daemon) return null;
  const reason = getCliBinaryArtifactSupportTargetUnavailableReason(targetInputs);
  return reason ? `daemon: ${reason}` : null;
}

/**
 * Native support admission is shared by the payload owner and source-bootstrap
 * worker preflight, which runs before compiled workspace exports are refreshed.
 */
export function getCliBinaryArtifactSupportTargetUnavailableReason({
  target,
  platform = process.platform,
  arch = process.arch,
  commandProbe = command => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0,
}) {
  const hostOs = platform === 'win32' ? 'windows' : platform;
  if (hostOs === target.os && arch === target.arch) return null;
  if (hostOs === 'linux' && arch === 'x64' && target.os === 'linux' && target.arch === 'arm64') {
    const missing = ['npm', 'aarch64-linux-gnu-gcc', 'aarch64-linux-gnu-g++', 'make', 'python3'].filter(command => !commandProbe(command));
    return missing.length ? `[component-artifacts] linux-arm64 daemon support cross-build requires: ${missing.join(', ')}` : null;
  }
  return `[component-artifacts] host-native runtime packages require a matching host target (host ${hostOs}-${arch}, target ${target.os}-${target.arch}): daemon support includes node-pty native builds; package-manager CPU/OS selection alone cannot produce a target addon`;
}
