import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import type { ArtifactSharingResourceV1 } from '../artifacts/artifactSharingV1.js';
import { artifactSavedByFromActionContextV1, type ArtifactSavedByV1 } from '../artifacts/artifactBinaryV1.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';
import { ProfileRecordIdV1Schema, StoredProfileRecordV1Schema, type ProfileRecordV1 } from '../profiles/profileRecordSchemaV1.js';
import {
  LaunchProfileArtifactReferenceV1Schema, LaunchProfileArtifactV1Schema,
  PublishableLaunchProfileV1Schema, readLaunchProfileArtifactV1,
  buildLaunchProfileArtifactHeaderV1,
} from './launchProfileArtifactV1.js';

export const LaunchProfilePublishInputV1Schema = lazyZodSchema(() => z.object({ profileId: ProfileRecordIdV1Schema }).strict());
export const LaunchProfilePublishOutputV1Schema = LaunchProfileArtifactReferenceV1Schema;
export type LaunchProfilePublisherV1 = Readonly<{
  publish: (input: z.input<typeof LaunchProfilePublishInputV1Schema>, options?: Readonly<{ signal?: AbortSignal; context?: ActionExecutorContext }>) => Promise<z.output<typeof LaunchProfilePublishOutputV1Schema>>;
}>;

type LaunchProfileArtifactStoreV1 = Readonly<{
  read: (artifactId: string, signal?: AbortSignal) => Promise<ArtifactSharingResourceV1 | null>;
  create: (input: Readonly<{ header: Readonly<Record<string, unknown>>; body: string; savedBy?: ArtifactSavedByV1; signal?: AbortSignal }>) => Promise<Readonly<{ artifactId: string }> | null>;
}>;
export type LaunchProfilePublisherDepsV1 = Readonly<{ artifactStore: LaunchProfileArtifactStoreV1 }> &
  Readonly<{ profileStore: Readonly<{
    read: (profileId: string, signal?: AbortSignal) => Promise<Readonly<{ record: ProfileRecordV1; revision: number }> | null>;
    updateDefinition: (input: Readonly<{ profileId: string; expectedRevision: number; artifactId: string }>, signal?: AbortSignal) => Promise<void>;
  }> }>;

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
/** Publish the value-free definition; private attachments remain in the captured Profile row. */
export function createLaunchProfilePublisherV1(deps: LaunchProfilePublisherDepsV1): LaunchProfilePublisherV1 {
  return {
    publish: async (input, options) => {
      const signal = options?.signal;
      signal?.throwIfAborted();
      const { profileId } = LaunchProfilePublishInputV1Schema.parse(input);
      const current = await deps.profileStore.read(profileId, signal);
      signal?.throwIfAborted();
      if (!current) return fail('profile_not_found');
      const record = StoredProfileRecordV1Schema.parse(current.record);
      if (record.id !== profileId) return fail('profile_id_ambiguous');
      if (record.definition.kind === 'artifact') {
        const artifact = await deps.artifactStore.read(record.definition.artifactId, signal);
        signal?.throwIfAborted();
        if (!artifact || readLaunchProfileArtifactV1(artifact)?.profile.id !== profileId) return fail('profile_artifact_unavailable');
        return { artifactId: record.definition.artifactId };
      }
      const profile = createStoredReadSchema(PublishableLaunchProfileV1Schema).parse(record.definition.profile);
      const content = preparePublishedContent(profile);
      const artifact = await deps.artifactStore.create({ header: buildLaunchProfileArtifactHeaderV1(content), body: JSON.stringify(content),
        savedBy: artifactSavedByFromActionContextV1(options?.context), ...(signal ? { signal } : {}) });
      const reference = LaunchProfilePublishOutputV1Schema.safeParse({ artifactId: artifact?.artifactId });
      if (!reference.success) return fail('profile_publish_failed');
      signal?.throwIfAborted();
      await deps.profileStore.updateDefinition({ profileId, expectedRevision: current.revision, artifactId: reference.data.artifactId }, signal);
      return reference.data;
    },
  };
}

function preparePublishedContent(profile: z.output<typeof PublishableLaunchProfileV1Schema>) {
  const variables = 'v' in profile ? profile.extraEnvironmentVariables : profile.environmentVariables;
  if (variables.some((variable) => variable.value.length > 0)) fail('profile_contains_secret_values');
  const requirements = [...(profile.envVarRequirements ?? [])];
  for (const variable of variables) {
    if (!requirements.some((requirement) => requirement.name === variable.name)) {
      requirements.push({ name: variable.name, kind: variable.isSecret === false ? 'config' : 'secret', required: false });
    }
  }
  return LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1',
    profile: { ...profile, ...('v' in profile ? { extraEnvironmentVariables: [] } : { environmentVariables: [] }), envVarRequirements: requirements },
    secretBindings: {} });
}
