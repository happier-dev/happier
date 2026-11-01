import { COMPUTER_AGENT_DESKTOP_INSTALLABLE_DESCRIPTOR, COMPUTER_AGENT_DESKTOP_INSTALLABLE_KEY, COMPUTER_AGENT_DESKTOP_VERSION, type InstallableDependencyDescriptor } from '@happier-dev/protocol/installables';
import { createPinnedArchiveRuntimeInstallableAdapter, installPinnedArchive, resolveInstalledPinnedArchiveExecutable, type PinnedArchiveAsset } from './pinnedArchive';
import type { RuntimeInstallableAdapter } from '../registry';
import { ARCHIVE_DOWNLOAD_INSTALLABLE_SOURCE_KIND, type ArchiveDownloadInstallableAdapter } from './browserChromium';

export { COMPUTER_AGENT_DESKTOP_INSTALLABLE_KEY, COMPUTER_AGENT_DESKTOP_VERSION };

function resolveAsset(platform: string, arch: string, descriptor = COMPUTER_AGENT_DESKTOP_INSTALLABLE_DESCRIPTOR): PinnedArchiveAsset | null {
  if (descriptor.source.kind !== 'pinned_archive') return null;
  if ((platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') || (arch !== 'arm64' && arch !== 'x64')) return null;
  return descriptor.source.assetsByPlatform[`${platform}-${arch}`] ?? null;
}

/** Capability repair and native launch use one descriptor and retained install. */
export function getComputerAgentDesktopRuntimeInstallableAdapter(descriptor: InstallableDependencyDescriptor): RuntimeInstallableAdapter {
  const asset = resolveAsset(process.platform, process.arch, descriptor);
  if (!asset || descriptor.source.kind !== 'pinned_archive') throw new Error('Unsupported Agent Desktop platform');
  if (!asset.sha256) throw new Error('Agent Desktop requires a pinned checksum');
  return { ...createPinnedArchiveRuntimeInstallableAdapter({
    installId: descriptor.capabilityId, managedInstallId: COMPUTER_AGENT_DESKTOP_INSTALLABLE_KEY,
    version: descriptor.source.version, asset,
  }), key: descriptor.key };
}

export function getComputerAgentDesktopArchiveDownloadInstallableAdapter(): ArchiveDownloadInstallableAdapter {
  return {
    key: COMPUTER_AGENT_DESKTOP_INSTALLABLE_KEY,
    sourceKind: ARCHIVE_DOWNLOAD_INSTALLABLE_SOURCE_KIND,
    async resolveInstalledExecutable(params = {}) {
      const platform = params.platform ?? process.platform;
      const asset = resolveAsset(platform, params.arch ?? process.arch);
      return asset ? await resolveInstalledPinnedArchiveExecutable({
        installId: COMPUTER_AGENT_DESKTOP_INSTALLABLE_KEY,
        executableSubpath: asset.executableSubpath,
        version: COMPUTER_AGENT_DESKTOP_VERSION,
        platform,
      }) : null;
    },
    async installOrUpgrade(params = {}) {
      const platform = params.platform ?? process.platform;
      const asset = resolveAsset(platform, params.arch ?? process.arch);
      if (!asset) return { ok: false, errorMessage: `Unsupported Agent Desktop platform: ${platform}/${params.arch ?? process.arch}` };
      if (!asset.sha256) return { ok: false, errorMessage: 'Agent Desktop requires a pinned checksum', errorCode: 'verification-failed' };
      const result = await installPinnedArchive({ installId: COMPUTER_AGENT_DESKTOP_INSTALLABLE_KEY, version: COMPUTER_AGENT_DESKTOP_VERSION, asset, platform });
      if (!result.ok) return result;
      if (result.checksum !== 'verified' || !result.integrityDigest) {
        return { ok: false, errorMessage: 'Agent Desktop checksum was not verified', errorCode: 'verification-failed' };
      }
      return { ok: true, executablePath: result.executablePath, pinnedVersion: result.version, integrityDigest: result.integrityDigest };
    },
  };
}
