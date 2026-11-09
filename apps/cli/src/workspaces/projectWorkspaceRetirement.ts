import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/mini';
import { projectNativeJsonValueForTransport, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { WorkspaceRefV1WriteSchema, type WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { assertProjectAccountSnapshotTransition, resolveProjectAccountWorkspaceRefRemovalV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import { canonicalAbsolutePathsEqual, isCanonicalAbsolutePathInsideRoot, resolveCanonicalAbsolutePathComparisonIdentity } from '@/utils/path/expandHomeDirPath';
import { mutateProjectAccountRows, readProjectAccountRows, type ActiveProjectAccountRowsSnapshot, type ProjectAccountRowsInput } from './projectAccountRows';

const OwnerDataSchema = z.strictObject({
  v: z.literal(1), scopeKey: z.string().check(z.minLength(1)), serverId: z.string().check(z.minLength(1)), machineId: z.string().check(z.minLength(1)),
  rootPath: z.string().check(z.minLength(1)), dependentWorktreePaths: z.array(z.string().check(z.minLength(1))),
  refs: z.array(z.strictObject({ revision: z.number().check(z.int(), z.nonnegative()), ref: WorkspaceRefV1WriteSchema })),
});
const StoredOwnerDataSchema = createStoredReadSchema(OwnerDataSchema);
type OwnerData = z.infer<typeof OwnerDataSchema>;

function failure(code: 'changed_since_review' | 'owner_data_invalid' | 'owner_unavailable' | 'restore_path_unsupported') {
  return Object.assign(new Error(code), { code });
}

/** Private checkout lifecycle; Account row storage and topology remain owned by projectAccountRows. */
export function createProjectWorkspaceRetirement(input: Readonly<{
  authority: ProjectAccountRowsInput; serverId: string; machineId: string; assertCurrentAuthority(): Promise<void>;
}>) {
  const authority = { ...input.authority, serverId: input.serverId, assertCurrentAuthority: async () => {
    await input.authority.assertCurrentAuthority?.();
    await input.assertCurrentAuthority();
  } };
  async function read() {
    await input.assertCurrentAuthority();
    const snapshot = await readProjectAccountRows({ ...authority, selection: { kinds: ['workspace-ref', 'relationship-graph'] } });
    await input.assertCurrentAuthority();
    return snapshot;
  }
  function affected(ref: WorkspaceRefV1, data: Pick<OwnerData, 'rootPath' | 'dependentWorktreePaths'>) {
    if (ref.serverId !== input.serverId || ref.machineId !== input.machineId) return false;
    if (!resolveCanonicalAbsolutePathComparisonIdentity(ref.rootPath)) throw failure('owner_unavailable');
    return isCanonicalAbsolutePathInsideRoot(data.rootPath, ref.rootPath)
      || data.dependentWorktreePaths.some(root => canonicalAbsolutePathsEqual(root, ref.rootPath));
  }
  function currentRefs(snapshot: ActiveProjectAccountRowsSnapshot, data: Pick<OwnerData, 'rootPath' | 'dependentWorktreePaths'>) {
    return snapshot.workspaceRefs.filter(ref => affected(ref, data)).map(ref => {
      const row = snapshot.rows.find(row => row.key.kind === 'workspace-ref' && row.key.serverId === ref.serverId && row.key.id === ref.id);
      if (!row?.payload) throw failure('owner_unavailable');
      return { revision: row.revision, ref };
    }).sort((a, b) => a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0);
  }
  function parse(raw: unknown) {
    const result = StoredOwnerDataSchema.safeParse(raw);
    if (!result.success || result.data.serverId !== input.serverId || result.data.machineId !== input.machineId
      || result.data.refs.some(({ ref }) => !affected(ref, result.data))
      || new Set(result.data.refs.map(({ ref }) => ref.id)).size !== result.data.refs.length) throw failure('owner_data_invalid');
    return result.data;
  }
  async function prepare(request: Readonly<{ rootPath: string; dependentWorktreePaths?: readonly string[] }>) {
    const paths = { rootPath: request.rootPath, dependentWorktreePaths: [...(request.dependentWorktreePaths ?? [])].sort() };
    if ([paths.rootPath, ...paths.dependentWorktreePaths].some(path => !resolveCanonicalAbsolutePathComparisonIdentity(path))) throw failure('owner_data_invalid');
    const snapshot = await read();
    const refs = currentRefs(snapshot, paths);
    for (const { ref } of refs) resolveProjectAccountWorkspaceRefRemovalV1(snapshot, { serverId: ref.serverId, workspaceRefId: ref.id });
    const ownerData = projectNativeJsonValueForTransport({ v: 1, scopeKey: snapshot.scopeKey,
      serverId: input.serverId, machineId: input.machineId, ...paths, refs });
    return { ownerData, fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(ownerData)).digest('hex')}` };
  }
  async function assertCurrent(raw: JsonValue) {
    const data = parse(raw);
    const snapshot = await read();
    if (snapshot.scopeKey !== data.scopeKey || !isDeepStrictEqual(currentRefs(snapshot, data), data.refs)) throw failure('changed_since_review');
    for (const { ref } of data.refs) resolveProjectAccountWorkspaceRefRemovalV1(snapshot, { serverId: ref.serverId, workspaceRefId: ref.id });
  }
  function retainedRowsMatch(snapshot: ActiveProjectAccountRowsSnapshot, data: OwnerData, phase: 'original' | 'retired' | 'reinstated') {
    const advance = phase === 'original' ? 0 : phase === 'retired' ? 1 : 2;
    return data.refs.every(({ revision, ref }) => {
      const row = snapshot.rows.find(row => row.key.kind === 'workspace-ref' && row.key.serverId === ref.serverId && row.key.id === ref.id);
      return row?.revision === revision + advance && (phase === 'retired' ? row.payload === null : isDeepStrictEqual(row.payload?.value, ref));
    });
  }
  async function transition(raw: JsonValue, restoring: boolean) {
    const data = parse(raw);
    const snapshot = await read();
    if (snapshot.scopeKey !== data.scopeKey) throw failure('changed_since_review');
    const refs = currentRefs(snapshot, data);
    // Undo may restore bytes after a rejected write left the exact reviewed refs intact.
    if (restoring && retainedRowsMatch(snapshot, data, 'original') && isDeepStrictEqual(refs, data.refs)) return;
    if (restoring && retainedRowsMatch(snapshot, data, 'reinstated')
      && isDeepStrictEqual(refs.map(({ ref }) => ref), data.refs.map(({ ref }) => ref))) return;
    if (!restoring && retainedRowsMatch(snapshot, data, 'retired') && refs.length === 0) return;
    if (restoring ? !retainedRowsMatch(snapshot, data, 'retired') || refs.length > 0
      : !retainedRowsMatch(snapshot, data, 'original') || !isDeepStrictEqual(refs, data.refs)) throw failure('changed_since_review');
    if (data.refs.length === 0) return;
    let workspaceRefs = snapshot.workspaceRefs;
    if (restoring) workspaceRefs = [...workspaceRefs, ...data.refs.map(({ ref }) => ref)];
    else for (const { ref } of data.refs) workspaceRefs = resolveProjectAccountWorkspaceRefRemovalV1(
      { ...snapshot, workspaceRefs }, { serverId: ref.serverId, workspaceRefId: ref.id });
    assertProjectAccountSnapshotTransition(snapshot, { ...snapshot, workspaceRefs });
    await input.assertCurrentAuthority();
    const graphKey = { kind: 'relationship-graph' as const };
    const result = await mutateProjectAccountRows({ ...authority, snapshot, request: {
      topologyChange: true, expectedRefs: [], mutations: [
        ...data.refs.map(({ ref, revision }) => {
          const key = { kind: 'workspace-ref' as const, serverId: ref.serverId, id: ref.id };
          return { key, expectedRevision: revision + (restoring ? 1 : 0), payload: restoring ? { key, value: ref } : null };
        }),
        { key: graphKey, expectedRevision: snapshot.graphRevision,
          payload: { key: graphKey, value: { relationships: [...snapshot.relationships] } } },
      ],
    } });
    if (result.status === 'conflict') throw failure('changed_since_review');
    if (result.status !== 'updated') throw failure('owner_unavailable');
  }
  return { prepare, assertCurrent, retire: (raw: JsonValue) => transition(raw, false),
    async reinstate(raw: JsonValue, restorePath: string) {
      if (!canonicalAbsolutePathsEqual(parse(raw).rootPath, restorePath)) throw failure('restore_path_unsupported');
      await transition(raw, true);
    } };
}
