import semver from 'semver';

import type { PluginUpdatePolicy } from '@/plugins/store/install/trustIdentity';
import type { PluginStateRecord } from '@/plugins/store/state';

import type { PluginChangeRequest } from './changeContract';
import { DaemonPluginChangePreparationError } from './changeService';

type InstallNpmRequest = Extract<PluginChangeRequest, { kind: 'installNpm' }>;
type InstallArchiveRequest = Extract<PluginChangeRequest, { kind: 'installArchive' }>;
type InstallPathRequest = Extract<PluginChangeRequest, { kind: 'installPath' }>;

export type ResolvedInstalledPluginUpdate =
  | Readonly<{
      kind: 'npm';
      request: InstallNpmRequest;
      updatePolicy: Exclude<PluginUpdatePolicy, 'pinned'>;
    }>
  | Readonly<{ kind: 'archive'; request: InstallArchiveRequest }>
  | Readonly<{ kind: 'path'; request: InstallPathRequest }>;

function installedNpmUpdateSelector(version: string): string {
  const canonicalVersion = semver.valid(version);
  if (canonicalVersion !== version) {
    throw new DaemonPluginChangePreparationError(
      'plugin_update_trust_unavailable',
      `Installed plugin version '${version}' is not a canonical release version`,
    );
  }
  if (semver.prerelease(version) === null) return `>=${version}`;
  const parsed = semver.parse(version);
  if (!parsed) {
    throw new DaemonPluginChangePreparationError(
      'plugin_update_trust_unavailable',
      `Installed plugin version '${version}' is not a canonical release version`,
    );
  }
  return `>=${version} <${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

export function resolveInstalledPluginUpdate(
  pluginId: string,
  record: PluginStateRecord | undefined,
): ResolvedInstalledPluginUpdate {
  if (!record) {
    throw new DaemonPluginChangePreparationError(
      'plugin_not_found',
      `Unknown plugin id: ${pluginId}`,
    );
  }
  const trust = record.install.trust;
  if (!trust || trust.pluginId !== pluginId) {
    throw new DaemonPluginChangePreparationError(
      'plugin_update_trust_unavailable',
      `Plugin '${pluginId}' has no current trusted update channel`,
    );
  }
  const updatePolicy = record.install.updatePolicy ?? 'manual';
  if (updatePolicy === 'pinned') {
    throw new DaemonPluginChangePreparationError(
      'plugin_update_pinned',
      `Plugin '${pluginId}' is pinned and cannot advance until its update policy changes`,
    );
  }

  switch (trust.distribution.kind) {
    case 'npm':
      if (updatePolicy === 'automatic' && !record.install.curatedUpdateSource) {
        throw new DaemonPluginChangePreparationError(
          'plugin_update_trust_unavailable',
          `Plugin '${pluginId}' has no reviewed curated source binding for automatic updates`,
        );
      }
      return {
        kind: 'npm',
        request: {
          kind: 'installNpm',
          packageName: trust.distribution.packageName,
          selector: installedNpmUpdateSelector(record.install.manifestVersion),
          registryOrigin: trust.distribution.registryOrigin,
          ...(trust.distribution.registryProfileId
            ? { registryProfileId: trust.distribution.registryProfileId }
            : {}),
        },
        updatePolicy,
      };
    case 'archive':
      return {
        kind: 'archive',
        request: {
          kind: 'installArchive',
          locator: trust.distribution.source.kind === 'localFile'
            ? trust.distribution.source.canonicalPath
            : trust.distribution.source.canonicalUrl,
        },
      };
    case 'localPath':
      return {
        kind: 'path',
        request: {
          kind: 'installPath',
          locator: trust.distribution.canonicalPath,
          development: record.source.devWatch === true,
        },
      };
  }
}
