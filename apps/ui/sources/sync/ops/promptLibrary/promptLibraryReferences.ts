import type {
  PromptExternalLinksV1,
  PromptInvocationsV1,
  PromptStacksV1,
} from '@happier-dev/protocol';

export function removePromptLibraryArtifactReferences(args: Readonly<{
  artifactId: string;
  promptInvocationsV1: PromptInvocationsV1 | null | undefined;
  promptStacksV1: PromptStacksV1 | null | undefined;
  promptExternalLinksV1: PromptExternalLinksV1 | null | undefined;
}>): Readonly<{
  promptInvocationsV1: PromptInvocationsV1;
  promptStacksV1: PromptStacksV1;
  promptExternalLinksV1: PromptExternalLinksV1;
}> {
  const artifactId = args.artifactId.trim();

  return {
    promptInvocationsV1: {
      v: 1,
      entries: (args.promptInvocationsV1?.entries ?? []).filter((entry) => entry.target.artifactId !== artifactId),
    },
    promptStacksV1: {
      v: 1,
      surfaces: {
        coding: (args.promptStacksV1?.surfaces.coding ?? []).filter((entry) => entry.ref.artifactId !== artifactId),
        voice: (args.promptStacksV1?.surfaces.voice ?? []).filter((entry) => entry.ref.artifactId !== artifactId),
        profilesById: Object.fromEntries(
          Object.entries(args.promptStacksV1?.surfaces.profilesById ?? {}).map(([profileId, entries]) => (
            [profileId, entries.filter((entry) => entry.ref.artifactId !== artifactId)]
          )),
        ),
      },
    },
    promptExternalLinksV1: {
      v: 1,
      links: (args.promptExternalLinksV1?.links ?? []).filter((entry) => entry.artifactId !== artifactId),
    },
  };
}
