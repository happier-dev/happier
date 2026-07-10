import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import {
  getFirstPartyComponentCatalogEntry,
  resolveFirstPartyComponentPublicReleaseVariant,
  type FirstPartyComponentId,
} from '../../firstPartyRuntime/componentCatalog.js';

function normalizeBootstrapReleaseChannel(raw: unknown): PublicReleaseRingId {
  return normalizePublicReleaseRingId(raw) || 'stable';
}

export function normalizeRemoteFirstPartyHomeDir(raw: unknown): string {
  const trimmed = String(raw ?? '').trim();
  const normalized = trimmed || '$HOME/.happier';
  if (normalized === '~') {
    return '$HOME';
  }
  if (normalized.startsWith('~/')) {
    return normalizeRemoteFirstPartyHomeDir(`$HOME${normalized.slice(1)}`);
  }
  if (normalized.startsWith('$HOME')) {
    const rest = normalized.slice('$HOME'.length);
    if (rest && !rest.startsWith('/')) {
      throw new Error(`Unsupported remote home dir: ${normalized}`);
    }
    const segments = rest
      ? rest.slice(1).split('/').filter(Boolean)
      : [];
    for (const segment of segments) {
      if (segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/u.test(segment)) {
        throw new Error(`Unsupported remote home dir: ${normalized}`);
      }
    }
    return normalized;
  }
  if (normalized.startsWith('/')) {
    const segments = normalized.slice(1).split('/').filter(Boolean);
    for (const segment of segments) {
      if (segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/u.test(segment)) {
        throw new Error(`Unsupported remote home dir: ${normalized}`);
      }
    }
    return normalized;
  }
  throw new Error(`Unsupported remote home dir: ${normalized}`);
}

export function sanitizeRemoteFirstPartyPathSegment(value: string): string {
  const sanitized = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
  return sanitized || 'payload';
}

export type RemoteFirstPartyInstallLayout = Readonly<{
  remoteHomeDir: string;
  installRoot: string;
  versionsDir: string;
  versionDir: string;
  currentPath: string;
  previousPath: string;
  binaryPath: string;
}>;

export function resolveRemoteFirstPartyInstallLayout(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: string;
  versionId: string;
  remoteHomeDir?: string;
}>): RemoteFirstPartyInstallLayout {
  const channel = normalizeBootstrapReleaseChannel(params.channel);
  const component = getFirstPartyComponentCatalogEntry(params.componentId);
  const variant = resolveFirstPartyComponentPublicReleaseVariant({
    componentId: params.componentId,
    channel,
  });
  const remoteHomeDir = normalizeRemoteFirstPartyHomeDir(params.remoteHomeDir);
  const installRoot = `${remoteHomeDir}/${variant.installRootName}`;
  const versionsDir = `${installRoot}/versions`;
  const currentPath = `${installRoot}/current`;
  return {
    remoteHomeDir,
    installRoot,
    versionsDir,
    versionDir: `${versionsDir}/${sanitizeRemoteFirstPartyPathSegment(params.versionId)}`,
    currentPath,
    previousPath: `${installRoot}/previous`,
    binaryPath: `${currentPath}/${component.binaryRelativePath}`,
  };
}

export function buildRemoteFirstPartyPromotionCommand(params: Readonly<{
  layout: RemoteFirstPartyInstallLayout;
  payloadRootExpression: string;
}>): string {
  const payloadRootExpression = String(params.payloadRootExpression ?? '').trim();
  if (!payloadRootExpression) {
    throw new Error('Remote first-party payload root is required.');
  }
  const layout = params.layout;
  const versionBinaryPath = `${layout.versionDir}${layout.binaryPath.slice(layout.currentPath.length)}`;
  return [
    `mkdir -p ${layout.versionsDir}`,
    `rm -rf ${layout.versionDir}`,
    `cp -R ${payloadRootExpression} ${layout.versionDir}`,
    `chmod +x ${versionBinaryPath}`,
    `if [ -L ${layout.currentPath} ]; then prev="$(readlink ${layout.currentPath} || true)"; if [ -n "$prev" ]; then ln -sfn "$prev" ${layout.previousPath}; fi; fi`,
    `ln -sfn ${layout.versionDir} ${layout.currentPath}`,
  ].join('; ');
}

export function resolveRemoteInstalledFirstPartyBinaryPath(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: string;
  remoteHomeDir?: string;
}>): string {
  return resolveRemoteFirstPartyInstallLayout({
    componentId: params.componentId,
    channel: params.channel,
    versionId: 'current',
    remoteHomeDir: params.remoteHomeDir,
  }).binaryPath;
}

export function normalizeRemoteReleaseOs(value: unknown): 'linux' | 'darwin' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized.includes('darwin')) return 'darwin';
  if (normalized.includes('linux')) return 'linux';
  throw new Error(`Unsupported remote bootstrap platform: ${normalized || 'unknown'}`);
}

export function normalizeRemoteReleaseArch(value: unknown): 'x64' | 'arm64' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'x86_64' || normalized === 'amd64' || normalized === 'x64') return 'x64';
  if (normalized === 'aarch64' || normalized === 'arm64') return 'arm64';
  throw new Error(`Unsupported remote bootstrap architecture: ${normalized || 'unknown'}`);
}
