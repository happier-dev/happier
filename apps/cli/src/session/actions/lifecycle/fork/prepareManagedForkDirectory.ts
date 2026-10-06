import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import type { SessionCreationTagV1 } from '@happier-dev/protocol';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

/** Placement is host-owned; a plugin launch directory cannot share the parent's managed allocation. */
export function prepareManagedForkDirectory(input: Readonly<{
  parentSessionId: string;
  parentMetadata: Record<string, unknown>;
  directory: string;
  spawnNonce: string;
}>): Readonly<{ directory: string; directoryKind: 'managed'; sessionCreationTag: SessionCreationTagV1;
  managedDirectorySeed: NonNullable<SpawnSessionOptions['managedDirectorySeed']>;
}> | null {
  if (readSessionDirectoryKind(input.parentMetadata) !== 'managed') return null;
  const sessionCreationTag = deriveSessionCreationTagV1({ callerCreationNamespace: `session.fork:${input.parentSessionId}`, creationKey: input.spawnNonce });
  const prepared = createManagedSessionDirectories().prepareForCreation({ sessionCreationTag });
  const correspondence = SessionCreationCorrespondenceV1Schema.safeParse(input.parentMetadata.sessionCreationCorrespondenceV1);
  const sourceSessionCreationTag = correspondence.success ? correspondence.data.sessionCreationTag : undefined;
  return { directory: prepared.directory, directoryKind: 'managed', sessionCreationTag,
    managedDirectorySeed: { sourceSessionId: input.parentSessionId, sourcePath: input.directory,
      ...(sourceSessionCreationTag ? { sourceSessionCreationTag } : {}),
    },
  };
}
