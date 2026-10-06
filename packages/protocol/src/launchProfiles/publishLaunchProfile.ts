import { z } from 'zod';
import type { ArtifactSharingResourceV1 } from '../artifacts/artifactSharingV1.js';
import { artifactSavedByFromActionContextV1, type ArtifactSavedByV1 } from '../artifacts/artifactBinaryV1.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';
import { readAiLaunchProfileCollection } from '../profiles/read.js';
import {
  LaunchProfileArtifactReferenceV1Schema, LaunchProfileArtifactV1Schema,
  PublishableLaunchProfileV1Schema, readLaunchProfileArtifactV1,
  buildLaunchProfileArtifactHeaderV1,
} from './launchProfileArtifactV1.js';

export const LaunchProfilePublishInputV1Schema = z.object({ profileId: z.string().min(1) }).strict();
export const LaunchProfilePublishOutputV1Schema = LaunchProfileArtifactReferenceV1Schema;
export type LaunchProfilePublisherV1 = Readonly<{
  publish: (input: z.input<typeof LaunchProfilePublishInputV1Schema>, options?: Readonly<{ signal?: AbortSignal; context?: ActionExecutorContext }>) => Promise<z.output<typeof LaunchProfilePublishOutputV1Schema>>;
}>;
type RawSettings = Readonly<Record<string, unknown>>;

export type LaunchProfilePublisherDepsV1 = Readonly<{
  /** Opened raw Settings from the CAS owner, not a default-filled UI projection. */
  readSettings: (options?: Readonly<{ signal?: AbortSignal }>) => Promise<RawSettings>;
  /** The Account settings owner applies this transform against its current CAS winner. */
  mutateSettings: (mutate: (current: RawSettings) => Record<string, unknown>, options?: Readonly<{ signal?: AbortSignal }>) => Promise<void>;
  artifactStore: Readonly<{
    read: (artifactId: string, signal?: AbortSignal) => Promise<ArtifactSharingResourceV1 | null>;
    create: (input: Readonly<{ header: Readonly<Record<string, unknown>>; body: string; savedBy?: ArtifactSavedByV1; signal?: AbortSignal }>) => Promise<Readonly<{ artifactId: string }> | null>;
  }>;
}>;

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function readBindings(value: unknown): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('profile_secret_bindings_invalid');
  return value as Readonly<Record<string, unknown>>;
}
function inlineEntries(rows: readonly unknown[], profileId: string) {
  return readAiLaunchProfileCollection(rows).entries.filter((entry) => entry.kind !== 'opaque' && entry.profile.id === profileId);
}

/** One home on success: move the value-free document, then replace its exact Settings row. */
export function createLaunchProfilePublisherV1(deps: LaunchProfilePublisherDepsV1): LaunchProfilePublisherV1 {
  return {
    publish: async (input, options) => {
      const signal = options?.signal;
      signal?.throwIfAborted();
      const { profileId } = LaunchProfilePublishInputV1Schema.parse(input);
      const settings = await deps.readSettings(options);
      signal?.throwIfAborted();
      const rows = Array.isArray(settings.profiles) ? settings.profiles : [];
      const matching = inlineEntries(rows, profileId);
      if (matching.length > 1) fail('profile_id_ambiguous');
      const raw = matching[0]?.raw;
      if (raw === undefined) {
        // Retry after an acknowledged or ambiguous Settings write: read the referenced home.
        for (const row of rows) {
          const reference = LaunchProfileArtifactReferenceV1Schema.safeParse(row);
          if (!reference.success) continue;
          signal?.throwIfAborted();
          const artifact = await deps.artifactStore.read(reference.data.artifactId, signal);
          signal?.throwIfAborted();
          if (artifact && readLaunchProfileArtifactV1(artifact)?.profile.id === profileId) return reference.data;
        }
        return fail('profile_not_found');
      }
      const profile = PublishableLaunchProfileV1Schema.parse(raw);
      const variables = 'v' in profile ? profile.extraEnvironmentVariables : profile.environmentVariables;
      if (variables.some((variable) => variable.value.length > 0)) fail('profile_contains_secret_values');
      const requirements = [...(profile.envVarRequirements ?? [])];
      for (const variable of variables) {
        if (!requirements.some((requirement) => requirement.name === variable.name)) {
          // An empty configured slot was not a required input. Preserve its name
          // without inventing a launch blocker; explicit requirements above retain their policy.
          requirements.push({ name: variable.name, kind: variable.isSecret === false ? 'config' : 'secret', required: false });
        }
      }
      const bindings = readBindings(settings.secretBindingsByProfileId);
      const content = LaunchProfileArtifactV1Schema.parse({
        kind: 'launch-profile.v1',
        profile: { ...profile, ...('v' in profile ? { extraEnvironmentVariables: [] } : { environmentVariables: [] }), envVarRequirements: requirements },
        secretBindings: bindings[profileId] ?? {},
      });
      const artifact = await deps.artifactStore.create({
        header: buildLaunchProfileArtifactHeaderV1(content), body: JSON.stringify(content),
        savedBy: artifactSavedByFromActionContextV1(options?.context),
        ...(signal ? { signal } : {}),
      });
      if (!artifact) fail('profile_publish_failed');
      const reference = LaunchProfilePublishOutputV1Schema.safeParse({ artifactId: artifact.artifactId });
      if (!reference.success) fail('profile_publish_failed');
      const result = reference.data;
      signal?.throwIfAborted();
      await deps.mutateSettings((current) => {
        signal?.throwIfAborted();
        const currentRows = Array.isArray(current.profiles) ? current.profiles : [];
        const currentMatching = inlineEntries(currentRows, profileId);
        if (currentMatching.length !== 1) fail('profile_publish_conflict');
        const currentBindings = readBindings(current.secretBindingsByProfileId);
        if (JSON.stringify(currentMatching[0]?.raw) !== JSON.stringify(raw)
          || JSON.stringify(currentBindings[profileId]) !== JSON.stringify(bindings[profileId])) fail('profile_publish_conflict');
        const nextBindings = { ...currentBindings };
        delete nextBindings[profileId];
        return { ...current, profiles: currentRows.map((row) => row === currentMatching[0]?.raw ? result : row),
          secretBindingsByProfileId: nextBindings };
      }, options);
      return result;
    },
  };
}
