import type { DaemonServiceMode } from './plan';

export function isDaemonServiceModeSupported(
  platform: 'darwin' | 'linux' | 'win32',
  mode: DaemonServiceMode,
): boolean {
  return mode === 'user' || platform === 'linux';
}

export function assertDaemonServiceModeSupported(
  platform: 'darwin' | 'linux' | 'win32',
  mode: DaemonServiceMode,
): void {
  if (!isDaemonServiceModeSupported(platform, mode)) {
    throw new Error('System mode background services are only supported on Linux');
  }
}
