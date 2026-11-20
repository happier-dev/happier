import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import {
  buildSessionCreationCorrespondence,
  SessionCreationCorrespondenceV1ReadSchema,
} from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import type { SessionCreationTagV1 } from '@happier-dev/protocol';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

export function readForkWorkspacePlacement(metadata: Record<string, unknown>) {
  const correspondence = SessionCreationCorrespondenceV1ReadSchema.safeParse(metadata.sessionCreationCorrespondenceV1);
  return correspondence.success ? correspondence.data : null;
}

/** The child gets its own controller allocation and keeps an admitted in-place checkout. */
export function prepareManagedForkDirectory(input: Readonly<{
  parentSessionId: string;
  parentMetadata: Record<string, unknown>;
  directory: string;
  spawnNonce: string;
}>): Readonly<{ directory: string; directoryKind: 'managed'; sessionCreationTag: SessionCreationTagV1 } & Pick<SpawnSessionOptions,
  'sessionCreationCorrespondence' | 'managedTargetPlacement' | 'managedDirectorySeed'
>> | null {
  const correspondence = readForkWorkspacePlacement(input.parentMetadata);
  const parentRecipe = correspondence?.recipe;
  const inPlaceWorkspace = parentRecipe?.inPlaceWorkspace;
  if (!inPlaceWorkspace && readSessionDirectoryKind(input.parentMetadata) !== 'managed') return null;
  const sessionCreationTag = deriveSessionCreationTagV1({ callerCreationNamespace: `session.fork:${input.parentSessionId}`, creationKey: input.spawnNonce });
  const prepared = createManagedSessionDirectories().prepareForCreation({ sessionCreationTag });
  const base = { directory: prepared.directory, directoryKind: 'managed' as const, sessionCreationTag };
  if (inPlaceWorkspace && parentRecipe) {
    return { ...base,
      managedTargetPlacement: { managedId: inPlaceWorkspace.managedId, workspaceRoot: inPlaceWorkspace.rootPath },
      sessionCreationCorrespondence: buildSessionCreationCorrespondence({
        identity: { sessionCreationTag },
        recipe: {
          execution: { machineId: inPlaceWorkspace.controller.machineId, directory: { kind: 'managed' } },
          organization: { folderId: null, tagIds: [] },
          agentTarget: parentRecipe.agentTarget,
          inPlaceWorkspace,
        },
      }),
    };
  }
  const sourceSessionCreationTag = correspondence?.sessionCreationTag;
  return { ...base,
    managedDirectorySeed: { sourceSessionId: input.parentSessionId, sourcePath: input.directory,
      ...(sourceSessionCreationTag ? { sourceSessionCreationTag } : {}),
    },
  };
}
