import { compareVersions, parseVersion } from '@/utils/system/versionUtils';
import type { InstallableDepDataLike } from './installablesRegistry';

export function isInstallableDepUpdateAvailable(data: InstallableDepDataLike | null): boolean {
    if (!data?.installed) return false;
    const installed = data.installedVersion;
    const latest = data.latestVersionCheck && data.latestVersionCheck.ok ? data.latestVersionCheck.latestVersion : null;
    if (!installed || !latest) return false;
    const installedParsed = parseVersion(installed);
    const latestParsed = parseVersion(latest);
    if (!installedParsed || !latestParsed) return false;
    return compareVersions(installed, latest) < 0;
}
