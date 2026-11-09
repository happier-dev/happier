import {
  resolvePackagedWindowsServiceLauncherInstallSpec,
  type WindowsServiceLauncherInstallSpec,
} from '@happier-dev/cli-common/service';

/** Every service consumer resolves launcher bytes through the shared physical-runtime owner. */
export function resolveDaemonWindowsServiceLauncherInstallSpec(): WindowsServiceLauncherInstallSpec {
  return resolvePackagedWindowsServiceLauncherInstallSpec();
}
