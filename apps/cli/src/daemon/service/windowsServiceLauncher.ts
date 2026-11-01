import {
  resolvePackagedWindowsServiceLauncherInstallSpec,
  type WindowsServiceLauncherInstallSpec,
} from '@happier-dev/cli-common/service';

/**
 * The packaged Windows launcher this CLI installs for its daemon task. Install planning,
 * installed paths and discovery must agree on it, since its bytes name the staged directory.
 */
export function resolveDaemonWindowsServiceLauncherInstallSpec(): WindowsServiceLauncherInstallSpec {
  return resolvePackagedWindowsServiceLauncherInstallSpec();
}
