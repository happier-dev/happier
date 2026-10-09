import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { resolveArtifactOrganizationHeaderV1, type ArtifactOrganizationHeaderV1 } from '../../artifacts/artifactOrganizationV1.js';
import { ArtifactRevisionV1Schema } from '../../artifacts/artifactActionsV1.js';
import { readPromptLibraryCatalogRecordV1, type PromptLibraryCatalogSnapshotV1 } from './promptLibraryCatalogV1.js';
import type { PromptLibraryRecordV1, PromptLibraryRowMutationResponseV1Schema } from './promptLibraryRowsV1.js';
import { createPromptFolderV1, renamePromptFolderV1, movePromptFolderV1, removePromptFolderV1,
  placeArtifactInPromptFolderV1, type PromptFoldersV1 } from './promptFoldersV1.js';
import type { ArtifactFolderActionIdV1 } from './artifactFolderActionIdsV1.js';

const revision = lazyZodSchema(() => z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.literal('absent')]));
const id = lazyZodSchema(() => z.string().min(1));
export const ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1 = {
  'artifact.folders.create': lazyZodSchema(() => z.object({ id, name: id, parentId: id.nullable().optional(), expectedRevision: revision }).strict()),
  'artifact.folders.rename': lazyZodSchema(() => z.object({ folderId: id, name: id, expectedRevision: revision }).strict()),
  'artifact.folders.move': lazyZodSchema(() => z.object({ folderId: id, parentId: id.nullable(), expectedRevision: revision }).strict()),
  'artifact.folders.delete': lazyZodSchema(() => z.object({ folderId: id, expectedRevision: revision }).strict()),
  'artifact.folder.set': lazyZodSchema(() => z.object({ artifactId: id, folderId: id.nullable().optional(), tags: z.array(id).optional(),
    expectedRevision: revision }).strict().refine(value => value.folderId !== undefined || value.tags !== undefined, { message: 'Organization change required' })),
} as const;
export const ArtifactFolderMutationResultV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('updated'), revision: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.string().min(1) }).strict(),
]));
export type ArtifactFolderMutationResultV1 = z.infer<typeof ArtifactFolderMutationResultV1Schema>;
export const ArtifactOrganizationMutationFailureDetailsV1Schema = lazyZodSchema(() => z.object({
  artifactId: id,
  contentRevision: ArtifactRevisionV1Schema.optional(),
  organization: z.union([
    z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(),
    z.object({ status: z.literal('unavailable'), reason: z.string().min(1) }).strict(),
  ]),
}).strict());
export type ArtifactOrganizationMutationFailureDetailsV1 = z.infer<typeof ArtifactOrganizationMutationFailureDetailsV1Schema>;

/** A content receipt survives failure of its independent personal organization mutation. */
export class ArtifactOrganizationMutationFailureV1 extends Error {
  readonly code = 'artifact_organization_failed';
  readonly details: ArtifactOrganizationMutationFailureDetailsV1;
  constructor(details: ArtifactOrganizationMutationFailureDetailsV1, options?: ErrorOptions) {
    super('artifact_organization_failed', options);
    this.name = 'ArtifactOrganizationMutationFailureV1';
    this.details = ArtifactOrganizationMutationFailureDetailsV1Schema.parse(details);
  }
}
export const ARTIFACT_FOLDER_ACTION_OUTPUT_SCHEMAS_V1 = {
  'artifact.folders.create': ArtifactFolderMutationResultV1Schema,
  'artifact.folders.rename': ArtifactFolderMutationResultV1Schema,
  'artifact.folders.move': ArtifactFolderMutationResultV1Schema,
  'artifact.folders.delete': ArtifactFolderMutationResultV1Schema,
  'artifact.folder.set': ArtifactFolderMutationResultV1Schema,
} as const;

export type ArtifactFolderHeaderV1 = Readonly<{ artifactId: string; header: Readonly<Record<string, unknown>>; owned: boolean }>;
/** Transport/currentness only: personal organization semantics remain at this owner. */
export type ArtifactFolderActionPortV1 = Readonly<{
  serverId: string;
  matchesServerId?(serverId: string): boolean;
  assertCurrent(): void;
  readCatalog(signal?: AbortSignal): Promise<Readonly<{ catalog: PromptLibraryCatalogSnapshotV1;
    rawSettings?: Readonly<Record<string, unknown>>; sourceSettingsVersion?: number }>>;
  writeRecord(input: Readonly<{ record: PromptLibraryRecordV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number }>,
    signal?: AbortSignal): Promise<ReturnType<typeof PromptLibraryRowMutationResponseV1Schema.parse>>;
  readArtifactHeader(artifactId: string, signal?: AbortSignal): Promise<Omit<ArtifactFolderHeaderV1, 'artifactId'> | null>;
  listArtifactHeaders(signal?: AbortSignal): Promise<Readonly<{ items: readonly ArtifactFolderHeaderV1[];
    coverage: 'complete' | 'partial' | 'unavailable' }>>;
}>;
type FolderReadV1 = Readonly<{ status: 'ready'; value: PromptFoldersV1; revision: number | 'absent'; sourceSettingsVersion?: number }>
  | Readonly<{ status: 'unavailable'; reason: string }>;
function assertCurrent(port: ArtifactFolderActionPortV1, signal?: AbortSignal): void {
  signal?.throwIfAborted(); port.assertCurrent();
}
export async function readArtifactFolderCatalogV1(input: Readonly<{ port: ArtifactFolderActionPortV1; signal?: AbortSignal }>): Promise<FolderReadV1> {
  assertCurrent(input.port, input.signal);
  const projection = await input.port.readCatalog(input.signal);
  assertCurrent(input.port, input.signal);
  const read = readPromptLibraryCatalogRecordV1({ ...projection, key: 'folders' });
  if (read.status !== 'ready') return read;
  if (read.record.key !== 'folders') return { status: 'unavailable', reason: 'invalid-stored-content' };
  if (read.authority === 'inactive' && projection.sourceSettingsVersion === undefined) {
    return { status: 'unavailable', reason: 'source-currentness-unavailable' };
  }
  return { status: 'ready', value: read.record.value, revision: read.revision,
    ...(read.authority === 'inactive' ? { sourceSettingsVersion: projection.sourceSettingsVersion } : {}) };
}
async function writeFolders(port: ArtifactFolderActionPortV1, read: Extract<FolderReadV1, { status: 'ready' }>, value: PromptFoldersV1,
  signal?: AbortSignal): Promise<ArtifactFolderMutationResultV1> {
  assertCurrent(port, signal);
  const result = await port.writeRecord({ record: { key: 'folders', value }, expectedRevision: read.revision,
    ...(read.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: read.sourceSettingsVersion }) }, signal);
  // Do not turn a durable receipt into a replayable failure after cancellation or Home retirement.
  if (result.status === 'updated') return { status: 'updated', revision: result.revision };
  if (result.status === 'conflict') return { status: 'conflict', revision: result.revision };
  return { status: 'unavailable', reason: result.status };
}
function stale(read: Extract<FolderReadV1, { status: 'ready' }>, expectedRevision?: number | 'absent'): ArtifactFolderMutationResultV1 | null {
  return expectedRevision !== undefined && read.revision !== expectedRevision
    ? { status: 'conflict', revision: read.revision === 'absent' ? -1 : read.revision } : null;
}
export async function readArtifactOrganizationV1(input: Readonly<{ port: ArtifactFolderActionPortV1; artifactId: string; signal?: AbortSignal }>): Promise<
  Readonly<{ status: 'ready'; header: ArtifactOrganizationHeaderV1; revision: number | 'absent' }> | Readonly<{ status: 'unavailable'; reason: string }>> {
  const read = await readArtifactFolderCatalogV1(input);
  if (read.status !== 'ready') return read;
  const artifact = await input.port.readArtifactHeader(input.artifactId, input.signal);
  assertCurrent(input.port, input.signal);
  if (!artifact) return { status: 'unavailable', reason: 'artifact_not_found' };
  return { status: 'ready', revision: read.revision, header: resolveArtifactOrganizationHeaderV1({ artifactId: input.artifactId,
    artifactHeadersById: read.value.artifactHeadersById, ...artifact }) };
}
export async function mutateArtifactOrganizationV1(input: Readonly<{ port: ArtifactFolderActionPortV1; artifactId: string;
  change: Readonly<{ folderId?: string | null; tags?: readonly string[] }>; expectedRevision?: number | 'absent'; signal?: AbortSignal }>): Promise<ArtifactFolderMutationResultV1> {
  const read = await readArtifactFolderCatalogV1(input);
  if (read.status !== 'ready') return read;
  const conflict = stale(read, input.expectedRevision); if (conflict) return conflict;
  const artifact = await input.port.readArtifactHeader(input.artifactId, input.signal);
  assertCurrent(input.port, input.signal);
  if (!artifact) return { status: 'unavailable', reason: 'artifact_not_found' };
  const previous = resolveArtifactOrganizationHeaderV1({ artifactId: input.artifactId,
    artifactHeadersById: read.value.artifactHeadersById, ...artifact });
  const next = placeArtifactInPromptFolderV1(read.value, { artifactId: input.artifactId,
    folderId: input.change.folderId === undefined ? previous.folderId ?? null : input.change.folderId,
    ...(input.change.tags === undefined ? previous.tags === undefined ? {} : { tags: previous.tags } : { tags: input.change.tags }) });
  return writeFolders(input.port, read, next, input.signal);
}
export async function executeArtifactFolderActionV1(input: Readonly<{ port: ArtifactFolderActionPortV1; actionId: ArtifactFolderActionIdV1;
  input: unknown; signal?: AbortSignal }>): Promise<ArtifactFolderMutationResultV1> {
  if (input.actionId === 'artifact.folder.set') {
    const request = ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1[input.actionId].parse(input.input);
    return mutateArtifactOrganizationV1({ ...input, artifactId: request.artifactId, expectedRevision: request.expectedRevision,
      change: { ...(request.folderId === undefined ? {} : { folderId: request.folderId }), ...(request.tags === undefined ? {} : { tags: request.tags }) } });
  }
  const request = ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1[input.actionId].parse(input.input);
  const read = await readArtifactFolderCatalogV1(input);
  if (read.status !== 'ready') return read;
  const conflict = stale(read, request.expectedRevision); if (conflict) return conflict;
  let next: PromptFoldersV1;
  switch (input.actionId) {
    case 'artifact.folders.create': next = createPromptFolderV1(read.value, ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1[input.actionId].parse(request)); break;
    case 'artifact.folders.rename': next = renamePromptFolderV1(read.value, ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1[input.actionId].parse(request)); break;
    case 'artifact.folders.move': next = movePromptFolderV1(read.value, ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1[input.actionId].parse(request)); break;
    case 'artifact.folders.delete': {
      const deletion = ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1[input.actionId].parse(request);
      const inventory = await input.port.listArtifactHeaders(input.signal);
      assertCurrent(input.port, input.signal);
      if (inventory.coverage !== 'complete') return { status: 'unavailable', reason: 'artifact_inventory_incomplete' };
      const artifactHeadersById = { ...read.value.artifactHeadersById };
      const artifactIds: string[] = [];
      for (const artifact of inventory.items) {
        const header = resolveArtifactOrganizationHeaderV1({ ...artifact, artifactHeadersById });
        if (header.folderId !== deletion.folderId) continue;
        artifactHeadersById[artifact.artifactId] = header;
        artifactIds.push(artifact.artifactId);
      }
      next = removePromptFolderV1({ ...read.value, artifactHeadersById }, { ...deletion, artifactIds });
      break;
    }
  }
  return writeFolders(input.port, read, next, input.signal);
}
