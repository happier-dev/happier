import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  assertProjectAccountRowPayloadBindingV1,
  buildProjectAccountRowPhysicalKeyV1,
  ProjectAccountRowPayloadV1Schema,
  type ProjectAccountRowKeyV1,
  type ProjectAccountRowPayloadV1,
} from '../../packages/protocol/src/projects/projectAccountRowsV1.js';
import { parseProjectAccountSnapshotV1 } from '../../packages/protocol/src/projects/projectAccountSnapshotV1.js';

type OpenedRow = Readonly<{ key: ProjectAccountRowKeyV1; revision: number; payload: ProjectAccountRowPayloadV1 | null }>;
type Source = Readonly<{ version: number; raw: Readonly<Record<string, unknown>> }>;
export type ProjectSettingsCutoverWrite = Readonly<{
  mutations: readonly Readonly<{
    key: ProjectAccountRowKeyV1;
    expectedRevision: number | 'absent';
    payload: ProjectAccountRowPayloadV1;
  }>[];
  expectedRefs: readonly Readonly<{
    key: Extract<ProjectAccountRowKeyV1, { kind: 'workspace-ref' }>;
    expectedRevision: number | 'absent';
  }>[];
  topologyChange: boolean;
}>;
export type ProjectSettingsCutoverPorts = Readonly<{
  readSource(): Promise<Source>;
  readRows(): Promise<readonly OpenedRow[]>;
  writeRows(write: ProjectSettingsCutoverWrite): Promise<'updated' | 'conflict'>;
  retireSource(source: Source): Promise<'updated' | 'conflict'>;
  retainRecency?(entries: readonly Readonly<{ serverId: string; projectKey: string; lastOpenedAtMs: number }>[]): Promise<void>;
}>;

const SOURCE_ROOTS = ['workspaceRefsV1', 'workspaceSyncRelationshipsV1', 'pinnedWorkspaceRefIdsV1'] as const;

/** Bounded development operation; never called from product startup or a settings reader. */
export async function cutoverProjectAccountSettings(ports: ProjectSettingsCutoverPorts): Promise<
  Readonly<{ status: 'cutover' | 'not-needed' | 'source-conflict' | 'destination-conflict' }>
> {
  const source = await ports.readSource();
  if (!SOURCE_ROOTS.some(key => Object.hasOwn(source.raw, key))) return { status: 'not-needed' };
  for (const key of SOURCE_ROOTS) {
    if (Object.hasOwn(source.raw, key) && !Array.isArray(source.raw[key])) {
      throw new Error(`Retained ${key} is malformed; repair its raw source before cutover`);
    }
  }
  const retained = parseProjectAccountSnapshotV1({
    workspaceRefs: source.raw.workspaceRefsV1 ?? [],
    relationships: source.raw.workspaceSyncRelationshipsV1 ?? [],
  });
  // A tolerant product read may project extras or recover optional values. A
  // destructive source retirement may not: retain those bytes for operator repair.
  if (!isDeepStrictEqual(retained.workspaceRefs, source.raw.workspaceRefsV1 ?? [])
    || !isDeepStrictEqual(retained.relationships, source.raw.workspaceSyncRelationshipsV1 ?? [])) {
    throw new Error('Retained Project data needs a lossless repair before source retirement');
  }
  const pins = source.raw.pinnedWorkspaceRefIdsV1 ?? [];
  if (!Array.isArray(pins) || !pins.every(id => typeof id === 'string' && id.length > 0)) {
    throw new Error('Retained Project pins are malformed; repair their raw source before cutover');
  }
  const pinnedRefs = pins.map(id => {
    const refs = retained.workspaceRefs.filter(ref => ref.id === id);
    if (refs.length !== 1) throw new Error('Retained Project pin is missing or ambiguous; repair its raw source before cutover');
    return refs[0];
  });
  const recencyByProject = new Map<string, { serverId: string; projectKey: string; lastOpenedAtMs: number }>();
  for (const ref of retained.workspaceRefs) {
    if (typeof ref.lastOpenedAtMs !== 'number') continue;
    const entry = { serverId: ref.serverId, projectKey: ref.projectKey ?? ref.id, lastOpenedAtMs: ref.lastOpenedAtMs };
    const key = JSON.stringify([entry.serverId, entry.projectKey]);
    const prior = recencyByProject.get(key);
    if (!prior || prior.lastOpenedAtMs < entry.lastOpenedAtMs) recencyByProject.set(key, entry);
  }
  const recency = [...recencyByProject.values()];
  if (recency.length > 0 && !ports.retainRecency) {
    throw new Error('Retained Project recency requires the canonical authoring/navigation-memory cutover port');
  }

  const rows = await ports.readRows();
  const current = new Map<string, OpenedRow>();
  for (const row of rows) {
    const key = buildProjectAccountRowPhysicalKeyV1(row.key);
    if (current.has(key)) throw new Error('Project destination contains duplicate row identities');
    if (row.payload) assertProjectAccountRowPayloadBindingV1(row.key, row.payload);
    current.set(key, row);
  }
  const desired = new Map<string, ProjectAccountRowPayloadV1>();
  for (const ref of retained.workspaceRefs) {
    const { lastOpenedAtMs: _recency, ...value } = ref;
    const key = { kind: 'workspace-ref' as const, serverId: ref.serverId, id: ref.id };
    desired.set(buildProjectAccountRowPhysicalKeyV1(key), ProjectAccountRowPayloadV1Schema.parse({ key, value }));
  }
  for (const ref of pinnedRefs) {
    const key = { kind: 'project-organization' as const, serverId: ref.serverId, projectKey: ref.projectKey ?? ref.id };
    const physicalKey = buildProjectAccountRowPhysicalKeyV1(key);
    const prior = current.get(physicalKey);
    if (prior?.payload === null) return { status: 'destination-conflict' };
    const value = prior?.payload?.key.kind === 'project-organization' ? prior.payload.value : {};
    if ('pinned' in value && value.pinned === false) return { status: 'destination-conflict' };
    desired.set(physicalKey, ProjectAccountRowPayloadV1Schema.parse({ key, value: { ...value, pinned: true } }));
  }

  const refs = rows.flatMap(row => row.payload?.key.kind === 'workspace-ref' && 'id' in row.payload.value ? [row.payload.value] : []);
  for (const payload of desired.values()) {
    if (payload.key.kind !== 'workspace-ref' || !('id' in payload.value)) continue;
    const key = buildProjectAccountRowPhysicalKeyV1(payload.key);
    const prior = current.get(key);
    if (prior && (prior.payload === null || !isDeepStrictEqual(prior.payload, payload))) return { status: 'destination-conflict' };
    if (!prior) refs.push(payload.value);
  }
  const graphKey = { kind: 'relationship-graph' as const };
  const graphIdentity = buildProjectAccountRowPhysicalKeyV1(graphKey);
  const graph = current.get(graphIdentity);
  if (graph?.payload === null) return { status: 'destination-conflict' };
  const relationships = graph?.payload && 'relationships' in graph.payload.value ? [...graph.payload.value.relationships] : [];
  for (const relationship of retained.relationships) {
    const prior = relationships.find(value => value.relationshipId === relationship.relationshipId);
    if (prior && !isDeepStrictEqual(prior, relationship)) return { status: 'destination-conflict' };
    if (!prior) relationships.push(relationship);
  }
  parseProjectAccountSnapshotV1({ workspaceRefs: refs, relationships });
  const topologyChange = retained.workspaceRefs.some(ref => !current.has(buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: ref.serverId, id: ref.id })))
    || !isDeepStrictEqual(relationships, graph?.payload && 'relationships' in graph.payload.value ? graph.payload.value.relationships : []);
  if (topologyChange) desired.set(graphIdentity, ProjectAccountRowPayloadV1Schema.parse({ key: graphKey, value: { relationships } }));

  const mutations: ProjectSettingsCutoverWrite['mutations'][number][] = [];
  for (const [identity, payload] of desired) {
    const prior = current.get(identity);
    if (prior?.payload === null) return { status: 'destination-conflict' };
    if (!isDeepStrictEqual(prior?.payload, payload)) mutations.push({ key: payload.key, expectedRevision: prior?.revision ?? 'absent', payload });
  }
  if (ports.retainRecency && recency.length > 0) await ports.retainRecency(recency);
  if (mutations.length > 0) {
    const result = await ports.writeRows({ mutations, topologyChange, expectedRefs: topologyChange ? refs.map(ref => {
      const key = { kind: 'workspace-ref' as const, serverId: ref.serverId, id: ref.id };
      return { key, expectedRevision: current.get(buildProjectAccountRowPhysicalKeyV1(key))?.revision ?? 'absent' };
    }) : [] });
    if (result === 'conflict') return { status: 'destination-conflict' };
  }
  const acknowledged = new Map((await ports.readRows()).map(row => [buildProjectAccountRowPhysicalKeyV1(row.key), row] as const));
  for (const [identity, payload] of desired) {
    if (!isDeepStrictEqual(acknowledged.get(identity)?.payload, payload)) throw new Error('Project cutover destination acknowledgement is incomplete; source retained');
  }
  const latest = await ports.readSource();
  if (latest.version !== source.version || !isDeepStrictEqual(latest.raw, source.raw)) return { status: 'source-conflict' };
  const raw = { ...source.raw };
  for (const key of SOURCE_ROOTS) delete raw[key];
  return { status: await ports.retireSource({ version: source.version, raw }) === 'updated' ? 'cutover' : 'source-conflict' };
}

/** Run from this checkout with the intended CLI Home/Account configuration, never at startup. */
async function main(): Promise<void> {
  if (process.argv.slice(2).length !== 1 || process.argv[2] !== '--apply') {
    process.stdout.write('Usage: TSX_TSCONFIG_PATH=apps/cli/tsconfig.json node --conditions=happier-source --import tsx scripts/migrations/cutoverProjectAccountSettings.ts --apply\n');
    return;
  }
  const [{ readCredentials }, settings, rows] = await Promise.all([
    import('../../apps/cli/src/persistence.js'),
    import('../../apps/cli/src/settings/accountSettings/updateAccountSettingsV2WithRetry.js'),
    import('../../apps/cli/src/workspaces/projectAccountRows.js'),
  ]);
  const credentials = await readCredentials();
  if (!credentials) throw new Error('The selected CLI Account must be authenticated before Project cutover');
  let envelopeKind: 'plain' | 'encrypted' | undefined;
  const result = await cutoverProjectAccountSettings({
    async readSource() {
      const source = await settings.readAccountSettingsV2Raw({ credentials });
      envelopeKind = source.envelopeKind;
      return source;
    },
    async readRows() { return (await rows.readProjectAccountRows({ credentials })).rows; },
    async writeRows(write) {
      const response = await rows.mutateProjectAccountRows({ credentials,
        request: { ...write, expectedRefs: [...write.expectedRefs] } });
      if (response.status === 'updated') return 'updated';
      if (response.status === 'conflict') return 'conflict';
      throw new Error(`Project destination refused cutover: ${response.status}`);
    },
    async retainRecency(entries) {
      const { retainProjectLastOpenedMemory } = await import('../../apps/cli/src/workspaces/projectLastOpenedMemory.js');
      for (const entry of entries) await retainProjectLastOpenedMemory({ credentials, ...entry });
    },
    async retireSource(source) {
      if (!envelopeKind) throw new Error('Project cutover has no opened source envelope');
      const response = await settings.replaceAccountSettingsV2RawForOwnerCutover({
        credentials, expectedVersion: source.version, raw: { ...source.raw }, envelopeKind,
      });
      if (response.success) return 'updated';
      if (response.error === 'version-mismatch') return 'conflict';
      throw new Error('Project source retirement refused; destination remains retained');
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'source-conflict' || result.status === 'destination-conflict') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Never print a transport exception: it may carry credentialed request configuration.
    process.stderr.write('Project cutover refused or unavailable; source retirement was not confirmed. Repair the retained source or destination before retrying.\n');
    process.exitCode = 1;
  });
}
