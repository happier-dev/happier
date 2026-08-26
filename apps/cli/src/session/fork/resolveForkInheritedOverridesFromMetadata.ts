import type { Metadata } from '@/api/types';

import {
  CHILD_SESSION_INHERITANCE_FIELD_SETS,
  resolveChildSessionInheritedContextFromMetadata,
  type ChildSessionInheritedMetadataOverrides,
  type ChildSessionInheritedSpawnOverrides,
} from '../inheritance/resolveChildSessionInheritedContextFromMetadata';

type ForkInheritedSpawnOverrides = Omit<
  ChildSessionInheritedSpawnOverrides,
  'mcpSelection' | 'profileId'
>;

type ForkInheritedMetadataOverrides = Pick<
  ChildSessionInheritedMetadataOverrides,
  | 'permissionMode'
  | 'permissionModeUpdatedAt'
  | 'modelOverrideV1'
  | 'sessionModesV1'
  | 'sessionModelsV1'
  | 'sessionConfigOptionsV1'
  | 'sessionModeOverrideV1'
  | 'sessionConfigOptionOverridesV1'
  | 'acpSessionModesV1'
  | 'acpSessionModelsV1'
  | 'acpConfigOptionsV1'
  | 'acpSessionModeOverrideV1'
  | 'acpConfigOptionOverridesV1'
  | 'connectedServices'
  | 'connectedServicesUpdatedAt'
> & Pick<Metadata, 'summary'>;

const FORK_TITLE_SUFFIX_PATTERN = /^(.*) \(fork ([1-9]\d*)\)$/i;

function resolveForkDisplayTitle(
  metadata: Record<string, unknown> | null | undefined,
): Metadata['summary'] | undefined {
  const summary = metadata?.summary;
  const summaryRecord = summary && typeof summary === 'object' && !Array.isArray(summary)
    ? summary as Record<string, unknown>
    : null;
  const summaryText = typeof summaryRecord?.text === 'string' ? summaryRecord.text.trim() : '';
  // Read compatibility for children created by the earlier name-only fork implementation.
  const legacyName = typeof metadata?.name === 'string' ? metadata.name.trim() : '';
  const title = summaryText || legacyName;
  if (!title) return undefined;

  const suffix = title.match(FORK_TITLE_SUFFIX_PATTERN);
  const previousForkNumber = suffix ? Number(suffix[2]) : 0;
  const canIncrementSuffix = suffix !== null && Number.isSafeInteger(previousForkNumber);
  const baseTitle = canIncrementSuffix ? suffix[1].trimEnd() : title;
  const forkNumber = canIncrementSuffix ? previousForkNumber + 1 : 1;
  const inheritedUpdatedAt = typeof summaryRecord?.updatedAt === 'number'
    && Number.isFinite(summaryRecord.updatedAt)
    ? summaryRecord.updatedAt
    : Date.now();

  return {
    text: `${baseTitle} (fork ${forkNumber})`,
    updatedAt: inheritedUpdatedAt,
  };
}

export function resolveForkInheritedOverridesFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  providerId?: string | null,
): {
  spawn: ForkInheritedSpawnOverrides;
  metadata: ForkInheritedMetadataOverrides;
} {
  const inherited = resolveChildSessionInheritedContextFromMetadata({
    metadata,
    providerId,
    fields: CHILD_SESSION_INHERITANCE_FIELD_SETS.fork,
  });
  const summary = resolveForkDisplayTitle(metadata);

  return {
    spawn: inherited.spawn,
    metadata: {
      ...inherited.metadata,
      ...(summary ? { summary } : {}),
    } as ForkInheritedMetadataOverrides,
  };
}
