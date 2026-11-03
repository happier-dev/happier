import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { PluginStorePaths } from '../paths';
import type { InstallationStateRevisionReference, PluginInstallationStateRevision } from './generationStore';
import type { PluginRegistryCommitRecord } from './commitRecord';
import { isRegistryObject, PortableStorageIdSchema } from './commitRecordSchema';
import { installationStateRevisionEnvelopeShape } from './installationStateRevisionSchema';
import { createPluginStateFileSchema } from '../stateEnvelope';
import type { PluginStateFileV1 } from '../state';

const AdmittedInstallationStateRevisionSchema: z.ZodMiniType<PluginInstallationStateRevision> = z.strictObject({
  ...installationStateRevisionEnvelopeShape,
  plugins: z.custom<PluginInstallationStateRevision['plugins']>(isRegistryObject),
  rollbackRetention: z.custom<PluginInstallationStateRevision['rollbackRetention']>(Array.isArray),
  hardRevocationRevisions: z.optional(z.custom<PluginInstallationStateRevision['hardRevocationRevisions']>(isRegistryObject)),
  runtimeCatalog: z.optional(createPluginStateFileSchema(z.custom<PluginStateFileV1['plugins']>(isRegistryObject))),
  retainedRuntimeCatalog: z.optional(z.custom<PluginInstallationStateRevision['retainedRuntimeCatalog']>(isRegistryObject)),
});
const AdmittedInstallationStateRevisionStoredReadSchema = createStoredReadSchema(AdmittedInstallationStateRevisionSchema);

export function stateRevisionPath(paths: PluginStorePaths, revisionId: string): string {
  return join(paths.stateRevisionsDir, revisionId, 'plugin-installations.v1.json');
}

export async function readInstallationStateRevisionValue(input: Readonly<{
  paths: PluginStorePaths;
  reference: InstallationStateRevisionReference;
  commit?: PluginRegistryCommitRecord;
}>): Promise<unknown> {
  if (input.commit && input.commit.installationState.revisionId !== input.reference.revisionId) {
    throw new Error('Installation state reference does not match its registry commit');
  }
  if (!PortableStorageIdSchema.safeParse(input.reference.revisionId).success) throw new Error('Invalid installation state revision');
  const raw = await readFile(stateRevisionPath(input.paths, input.reference.revisionId), 'utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error('Invalid installation state revision', { cause: error });
  }
}

/** Only the persisted v1 envelope is read here; admission owns its row bodies. */
export async function readAdmittedInstallationStateRevision(input: Readonly<{
  paths: PluginStorePaths;
  reference: InstallationStateRevisionReference;
  commit: PluginRegistryCommitRecord;
}>): Promise<PluginInstallationStateRevision> {
  const value = await readInstallationStateRevisionValue(input);
  return parseAdmittedInstallationStateRevision(value, input.reference);
}

function parseAdmittedInstallationStateRevision(
  value: unknown,
  reference: InstallationStateRevisionReference,
): PluginInstallationStateRevision {
  const parsed = AdmittedInstallationStateRevisionStoredReadSchema.safeParse(value);
  if (!parsed.success || parsed.data.revisionId !== reference.revisionId) {
    throw new Error('Invalid installation state revision');
  }
  return parsed.data;
}

export function readAdmittedInstallationStateRevisionSync(input: Readonly<{
  paths: PluginStorePaths;
  commit: PluginRegistryCommitRecord;
}>): PluginInstallationStateRevision {
  const reference = input.commit.installationState;
  if (!PortableStorageIdSchema.safeParse(reference.revisionId).success) throw new Error('Invalid installation state revision');
  const raw = readFileSync(stateRevisionPath(input.paths, reference.revisionId), 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error('Invalid installation state revision', { cause: error });
  }
  return parseAdmittedInstallationStateRevision(value, reference);
}
