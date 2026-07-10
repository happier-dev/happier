import { randomUUID } from 'node:crypto';
import { lstat, rename } from 'node:fs/promises';

import type { FirstPartyComponentId } from './componentCatalog.js';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { listInstalledVersionIdsNewestFirst } from './listInstalledVersionIdsNewestFirst.js';
import { promoteVersionedPayload, type FirstPartyPayloadPromotionResult } from './promoteVersionedPayload.js';
import { pruneRetainedVersions } from './pruneRetainedVersions.js';
import { shouldPersistDefaultManagedReleaseChannel, writeDefaultManagedReleaseChannel } from './defaultReleaseChannelState.js';
import { syncInstalledFirstPartyShims } from './syncInstalledFirstPartyShims.js';
import { joinPathForPathShape } from '../path/pathShape.js';
import { resolveFirstPartyInstallLayout, resolveFirstPartyVersionInstallPath, type FirstPartyInstallLayout } from './installLayout.js';

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

export async function installVersionedPayload(params: Readonly<{
  componentId: FirstPartyComponentId;
  versionId: string;
  payloadRoot: string;
  payloadRootAlreadyFiltered?: boolean;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<FirstPartyPayloadPromotionResult> {
  const layout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });

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
}

async function installVersionedPayloadOnce(params: Readonly<{
  componentId: FirstPartyComponentId;
  versionId: string;
  payloadRoot: string;
  payloadRootAlreadyFiltered?: boolean;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<FirstPartyPayloadPromotionResult> {
  const promotion = await promoteVersionedPayload({
    componentId: params.componentId,
    versionId: params.versionId,
    stagedPayloadPath: params.payloadRoot,
    stagedPayloadAlreadyFiltered: params.payloadRootAlreadyFiltered === true,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });

  const releaseChannel = params.channel ?? params.releaseRing ?? 'stable';

  await syncInstalledFirstPartyShims({
    componentId: params.componentId,
    channel: params.channel,
    defaultReleaseChannelOverride: releaseChannel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });

  if (shouldPersistDefaultManagedReleaseChannel(params.componentId)) {
    await writeDefaultManagedReleaseChannel({
      releaseChannel,
      processEnv: params.processEnv,
    });
  }

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
    currentVersionId: promotion.currentVersionId,
    previousVersionId: promotion.previousVersionId,
  });

  return promotion;
}
