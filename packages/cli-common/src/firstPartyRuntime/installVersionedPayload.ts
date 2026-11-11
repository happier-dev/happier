import { randomUUID } from 'node:crypto';
import type { FirstPartyAcquisitionOptions } from './acquisitionProgress.js';
import { lstat, rename } from 'node:fs/promises';

import type { FirstPartyComponentId } from './componentCatalog.js';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { listInstalledVersionIdsNewestFirst } from './listInstalledVersionIdsNewestFirst.js';
import { promoteVersionedPayload, type FirstPartyPayloadPromotionResult } from './promoteVersionedPayload.js';
import { pruneRetainedVersions } from './pruneRetainedVersions.js';
import {
  readDefaultManagedReleaseChannel,
  shouldPersistDefaultManagedReleaseChannel,
  writeDefaultManagedReleaseChannel,
} from './defaultReleaseChannelState.js';
import { syncInstalledFirstPartyShims } from './syncInstalledFirstPartyShims.js';
import { joinPathForPathShape } from '../path/pathShape.js';
import { resolveFirstPartyInstallLayout, resolveFirstPartyVersionInstallPath, type FirstPartyInstallLayout } from './installLayout.js';
import { readInstalledVersionMarkers } from './versionMarkers.js';
import { withFirstPartyActivationLock, withFirstPartyPayloadMutationLock } from './withFirstPartyPayloadMutationLock.js';
import { withDesktopResourceOwnership } from './desktopResourceOwnership.js';

function readErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  return typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function normalizePathText(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function errorMentionsInstallRoot(error: unknown, layout: FirstPartyInstallLayout): boolean {
  return normalizePathText(formatErrorMessage(error)).includes(normalizePathText(layout.installRoot));
}

function isRecoverableWindowsInstallRootError(error: unknown, layout: FirstPartyInstallLayout): boolean {
  if (process.platform !== 'win32' || !errorMentionsInstallRoot(error, layout)) {
    return false;
  }

  const code = readErrorCode(error);
  if (code === 'ENAMETOOLONG') {
    return true;
  }

  const message = formatErrorMessage(error).toLowerCase();
  if (message.includes('name too long') || message.includes('path too long')) {
    return true;
  }

  return (code === 'EINVAL' || code === 'ENOENT')
    && (message.includes('invalid argument') || message.includes('copyfile') || message.includes('no such file'));
}

async function quarantineWindowsInstallRoot(layout: FirstPartyInstallLayout): Promise<string | null> {
  const installRootExists = await lstat(layout.installRoot)
    .then(() => true)
    .catch((error) => {
      if (readErrorCode(error) === 'ENOENT') {
        return false;
      }
      throw error;
    });

  if (!installRootExists) {
    return null;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}${attempt === 0 ? '' : `-${attempt}`}`;
    const quarantinePath = joinPathForPathShape(
      layout.happyHomeDir,
      `.${layout.installRootName}.corrupt-${suffix}`,
    );

    try {
      await rename(layout.installRoot, quarantinePath);
      return quarantinePath;
    } catch (error) {
      if (readErrorCode(error) === 'ENOENT') {
        return null;
      }
      if (readErrorCode(error) === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Unable to quarantine corrupted install root '${layout.installRoot}' after multiple attempts.`);
}

function resolvePathRelativeToInstallRoot(params: Readonly<{
  absolutePath: string;
  installRoot: string;
}>): string | null {
  const normalizedInstallRoot = normalizePathText(params.installRoot).replace(/\/+$/, '');
  const normalizedAbsolutePath = normalizePathText(params.absolutePath);
  const prefix = `${normalizedInstallRoot}/`;
  if (!normalizedAbsolutePath.startsWith(prefix)) {
    return null;
  }
  const absolutePathWithoutDrive = params.absolutePath.replace(/^[a-zA-Z]:[\\/]/, '');
  const installRootWithoutDrive = params.installRoot.replace(/^[a-zA-Z]:[\\/]/, '');
  const normalizedInstallRootWithoutDrive = normalizePathText(installRootWithoutDrive).replace(/\/+$/, '');
  const normalizedAbsolutePathWithoutDrive = normalizePathText(absolutePathWithoutDrive);
  const prefixWithoutDrive = `${normalizedInstallRootWithoutDrive}/`;
  if (!normalizedAbsolutePathWithoutDrive.startsWith(prefixWithoutDrive)) {
    return null;
  }
  return absolutePathWithoutDrive.slice(installRootWithoutDrive.length).replace(/^[/\\]+/, '');
}

async function resolveWindowsRetryPayloadRoot(params: Readonly<{
  componentId: FirstPartyComponentId;
  versionId: string;
  payloadRoot: string;
  payloadRootAlreadyFiltered?: boolean;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
  layout: FirstPartyInstallLayout;
  quarantinedInstallRoot: string | null;
}>): Promise<string> {
  if (!params.quarantinedInstallRoot) {
    return params.payloadRoot;
  }
  const sourcePayloadExists = await lstat(params.payloadRoot)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (sourcePayloadExists) {
    return params.payloadRoot;
  }

  const expectedVersionPath = resolveFirstPartyVersionInstallPath({
    componentId: params.componentId,
    versionId: params.versionId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });
  const relativeVersionPath = resolvePathRelativeToInstallRoot({
    absolutePath: expectedVersionPath,
    installRoot: params.layout.installRoot,
  });
  if (!relativeVersionPath) {
    return params.payloadRoot;
  }

  const relocatedVersionPath = joinPathForPathShape(
    params.quarantinedInstallRoot,
    relativeVersionPath,
  );
  const relocatedPayloadExists = await lstat(relocatedVersionPath)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (relocatedPayloadExists) {
    return relocatedVersionPath;
  }
  return params.payloadRoot;
}

export async function installVersionedPayload(params: FirstPartyAcquisitionOptions & Readonly<{
  componentId: FirstPartyComponentId;
  versionId: string;
  payloadRoot: string;
  payloadRootAlreadyFiltered?: boolean;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
  /**
   * The user explicitly chose this channel as the default `happier` command (the official
   * installer's `--channel`). Without it an install never takes the default away from another
   * channel that is already installed — see `resolveDefaultReleaseChannelAfterInstall`.
   */
  selectAsDefaultReleaseChannel?: boolean;
  /** Actual Desktop acquisition; omitted explicit installs relinquish Desktop removal authority. */
  desktopBundleId?: string;
}>): Promise<FirstPartyPayloadPromotionResult> {
  params.signal?.throwIfAborted();
  const layout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });

  // Components with command shims or the default-channel record write the home-wide activation
  // domain too (`<home>/bin`, `default-cli-release-channel.json`), so they also hold its lock.
  const writesSharedActivationState = layout.installShims.length > 0 || shouldPersistDefaultManagedReleaseChannel(params.componentId);
  const withSharedActivationLock = async <T>(operation: () => Promise<T>): Promise<T> => writesSharedActivationState
    ? await withFirstPartyActivationLock({ happyHomeDir: layout.happyHomeDir, operation })
    : await operation();
  return await withFirstPartyPayloadMutationLock({
    layout,
    operation: async () => await withSharedActivationLock(async () => {
      const install = async () => {
        try {
          return await installVersionedPayloadOnce(params);
        } catch (error) {
          if (!isRecoverableWindowsInstallRootError(error, layout)) {
            throw error;
          }

          const quarantinedInstallRoot = await quarantineWindowsInstallRoot(layout);
          const retryPayloadRoot = await resolveWindowsRetryPayloadRoot({
            ...params,
            layout,
            quarantinedInstallRoot,
          });
          return await installVersionedPayloadOnce({
            ...params,
            payloadRoot: retryPayloadRoot,
          });
        }
      };
      if (params.componentId !== 'happier-cli') return await install();
      return await withDesktopResourceOwnership({
        resourcePath: layout.installRoot,
        bundleId: params.desktopBundleId,
        operation: async () => {
          const exists = await lstat(layout.installRoot).then(() => true).catch((error: unknown) => {
            if (readErrorCode(error) === 'ENOENT') return false;
            throw error;
          });
          return { value: await install(), created: !exists };
        },
      });
    }),
  });
}

type VersionedPayloadActivationParams = FirstPartyAcquisitionOptions & Readonly<{
  componentId: FirstPartyComponentId;
  versionId: string;
  payloadRoot: string;
  payloadRootAlreadyFiltered?: boolean;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
  /**
   * The user explicitly chose this channel as the default `happier` command (the official
   * installer's `--channel`). Without it an install never takes the default away from another
   * channel that is already installed — see `resolveDefaultReleaseChannelAfterInstall`.
   */
  selectAsDefaultReleaseChannel?: boolean;
}>;

async function installVersionedPayloadOnce(params: VersionedPayloadActivationParams): Promise<FirstPartyPayloadPromotionResult> {
  const promotion = await activateVersionedPayload(params);
  await pruneInstalledVersionsAfterActivation({
    componentId: params.componentId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
    currentVersionId: promotion.currentVersionId,
    previousVersionId: promotion.previousVersionId,
  });
  return promotion;
}

/**
 * Everything an install changes to make a version the running one — the versioned payload, the
 * `current`/`previous` pointers and markers, the default-channel record and the command shims —
 * without pruning. The caller holds the install mutation lock. `runManagedCliUpdate` activates
 * through this and prunes only after the new version proved itself, so the version it would roll
 * back to is still on disk while the service restarts.
 */
export async function activateVersionedPayload(params: VersionedPayloadActivationParams): Promise<FirstPartyPayloadPromotionResult> {
  // Promotion and shim/marker finalization finish together once started. Aborting halfway
  // through would leave a current pointer without its matching command shims.
  params.onProgress?.({ phase: 'installing' });
  const promotion = await promoteVersionedPayload({
    componentId: params.componentId,
    versionId: params.versionId,
    stagedPayloadPath: params.payloadRoot,
    stagedPayloadAlreadyFiltered: params.payloadRootAlreadyFiltered === true,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });

  params.onProgress?.({ phase: 'finalizing' });
  const releaseChannel = params.channel ?? params.releaseRing ?? 'stable';
  const defaultReleaseChannel = await resolveDefaultReleaseChannelAfterInstall({
    componentId: params.componentId,
    releaseChannel,
    selectAsDefault: params.selectAsDefaultReleaseChannel === true,
    processEnv: params.processEnv,
  });

  await syncInstalledFirstPartyShims({
    componentId: params.componentId,
    channel: params.channel,
    defaultReleaseChannelOverride: defaultReleaseChannel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });

  if (shouldPersistDefaultManagedReleaseChannel(params.componentId)) {
    await writeDefaultManagedReleaseChannel({
      releaseChannel: defaultReleaseChannel,
      processEnv: params.processEnv,
    });
  }

  return promotion;
}

/** Retention after an activation is committed: keep current + previous, prune the rest best-effort. */
export async function pruneInstalledVersionsAfterActivation(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
  currentVersionId: string;
  previousVersionId: string | null;
}>): Promise<void> {
  const orderedVersionIdsNewestFirst = await listInstalledVersionIdsNewestFirst({
    componentId: params.componentId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });

  await pruneRetainedVersions({
    componentId: params.componentId,
    processEnv: params.processEnv,
    channel: params.channel,
    releaseRing: params.releaseRing,
    orderedVersionIdsNewestFirst,
    currentVersionId: params.currentVersionId,
    previousVersionId: params.previousVersionId,
  });
}

/**
 * One default `happier` command per `~/.happier` (plan R10 D2). Installing a channel makes it the
 * default when the user chose it explicitly, when nothing else is installed, or when it already is
 * the default; otherwise the recorded default channel keeps the `happier` shim and the marker, so a
 * desktop app, a self-update or any other acquisition of a second channel never changes which CLI
 * the user's terminal and the default-following background service run.
 */
export async function resolveDefaultReleaseChannelAfterInstall(params: Readonly<{
  componentId: FirstPartyComponentId;
  releaseChannel: PublicReleaseRingId;
  selectAsDefault: boolean;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<PublicReleaseRingId> {
  if (params.selectAsDefault || !shouldPersistDefaultManagedReleaseChannel(params.componentId)) {
    return params.releaseChannel;
  }
  const currentDefault = await readDefaultManagedReleaseChannel({ processEnv: params.processEnv });
  if (currentDefault === params.releaseChannel) {
    return params.releaseChannel;
  }
  const { currentVersionId } = await readInstalledVersionMarkers(resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    channel: currentDefault,
    processEnv: params.processEnv,
  }));
  return currentVersionId ? currentDefault : params.releaseChannel;
}
