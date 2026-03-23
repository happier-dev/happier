import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveRetainedVersionIds } from '@happier-dev/cli-common/firstPartyRuntime';
import { compareVersions } from '@happier-dev/cli-common/update';

function trimVersionPrefix(entryName, entryPrefix) {
  const normalizedEntryName = String(entryName ?? '').trim();
  const normalizedPrefix = String(entryPrefix ?? '').trim();
  if (!normalizedEntryName || !normalizedPrefix || !normalizedEntryName.startsWith(normalizedPrefix)) {
    return '';
  }
  return normalizedEntryName.slice(normalizedPrefix.length).trim();
}

function compareSelfHostVersionIds(left, right) {
  const leftText = String(left ?? '').trim();
  const rightText = String(right ?? '').trim();
  const leftLocal = /^local-(\d+)$/.exec(leftText);
  const rightLocal = /^local-(\d+)$/.exec(rightText);
  if (leftLocal && rightLocal) {
    const leftValue = Number(leftLocal[1]);
    const rightValue = Number(rightLocal[1]);
    if (Number.isFinite(leftValue) && Number.isFinite(rightValue) && leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }
  return compareVersions(leftText, rightText);
}

export async function listVersionedDirectoryIdsNewestFirst({ versionsDir, entryPrefix }) {
  const entries = await readdir(versionsDir, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => trimVersionPrefix(entry.name, entryPrefix))
    .filter(Boolean)
    .sort((left, right) => compareSelfHostVersionIds(right, left));
}

export async function pruneVersionedDirectories({
  versionsDir,
  entryPrefix,
  currentVersionId,
  previousVersionId = null,
  retainCount = 2,
}) {
  const orderedVersionIdsNewestFirst = await listVersionedDirectoryIdsNewestFirst({
    versionsDir,
    entryPrefix,
  });
  const { keep, prune } = resolveRetainedVersionIds({
    orderedVersionIdsNewestFirst,
    currentVersionId,
    previousVersionId,
    retainCount,
  });

  await Promise.all(
    prune.map(async (versionId) => {
      await rm(join(versionsDir, `${entryPrefix}${versionId}`), { recursive: true, force: true });
    }),
  );

  return {
    keptVersionIds: keep,
    prunedVersionIds: prune,
  };
}
