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
> & { name?: string };

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
  const name = typeof metadata?.name === 'string' ? metadata.name.trim() : '';

  return {
    spawn: inherited.spawn,
    metadata: {
      ...inherited.metadata,
      ...(name ? { name } : {}),
    } as ForkInheritedMetadataOverrides,
  };
}
