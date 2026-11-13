import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionListQueryV1 } from '@happier-dev/protocol';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { SessionMetadataOwnerPatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { createMachineSessionProjectReclassification } from './reclassifyMachineSessionProjects';

afterEach(() => vi.restoreAllMocks());

const HOME = 'srv_home';
const credentials = { token: 'owner-token', encryption: null } as const;
const ref = (id: string, rootPath: string, machineId = 'machine-a'): WorkspaceRefV1 => ({ id, serverId: HOME, machineId, rootPath, createdAtMs: 1 });

type Row = { id: string; metadata: Metadata; projectKey: string | null; none: boolean; owner: boolean };

/** The Home is the network boundary: it stores rows and applies the published selector semantics. */
function createHome(rows: Row[]) {
  const queries: SessionListQueryV1[] = [];
  const patches: Array<{ sessionId: string; projectKey: string | null | undefined }> = [];
  const raw = (row: Row): RawSessionRecord => {
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
      metadata: row.metadata, agentState: null });
    return createSessionRecordFixture({ id: row.id, encryptionMode: 'plain', metadataVersion: 0, agentStateVersion: 0,
      metadataLayoutVersion: 1, metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
      projectKey: row.projectKey, ...(row.none ? { projectKeyNone: true as const } : {}),
      ...(row.owner ? { share: null } : { share: { accessLevel: 'edit', canApprovePermissions: false } }) }) as RawSessionRecord;
  };
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    throw new Error(`unexpected GET ${String(url)}`);
  });
  vi.spyOn(axios, 'patch').mockImplementation(async (url, body) => {
    const patch = SessionMetadataOwnerPatchV1Schema.parse(body);
    const sessionId = String(url).split('/').pop()!;
    patches.push({ sessionId, projectKey: patch.projectKey });
    const row = rows.find(candidate => candidate.id === sessionId)!;
    if (patch.projectKey !== undefined) { row.projectKey = patch.projectKey; row.none = patch.projectKey === null; }
    return { status: 200, data: { success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: patch.sharedMetadata.expectedVersion + 1 }, agentState: { version: patch.agentState.expectedVersion + 1 } } };
  });
  const readCandidates = async (query: SessionListQueryV1) => {
    queries.push(query);
    const selection = query.projectKeys!;
    const selected = rows.filter(row => selection.none ? row.projectKey === null && row.none
      : row.projectKey === null ? !row.none : selection.include.includes(row.projectKey));
    return { sessions: query.storage === 'active' ? selected.map(raw) : [], hasNext: false, nextCursor: null };
  };
  return { queries, patches, readCandidates };
}

describe('machine Session Project reclassification', () => {
  it('joins this Machine\'s no-Project Sessions at an exact new root, and downgrades them when that checkout is forgotten', async () => {
    const at = (path: string, extra: Partial<Metadata> = {}) => createTestMetadata({ path, machineId: 'machine-a', ...extra });
    const rows: Row[] = [
      { id: 'exact', metadata: at('/work/app'), projectKey: null, none: true, owner: true },
      { id: 'sibling-prefix', metadata: at('/work/app-2'), projectKey: null, none: true, owner: true },
      { id: 'subfolder', metadata: at('/work/app/sub'), projectKey: null, none: true, owner: true },
      { id: 'other-machine', metadata: createTestMetadata({ path: '/work/app', machineId: 'machine-b' }), projectKey: null, none: true, owner: true },
      { id: 'managed', metadata: at('/work/app', { sessionDirectoryV1: { v: 1, kind: 'managed' } } as Partial<Metadata>), projectKey: null, none: true, owner: true },
      { id: 'shared', metadata: at('/work/app'), projectKey: null, none: true, owner: false },
      { id: 'windows', metadata: at('c:/work/App'), projectKey: null, none: true, owner: true },
      { id: 'unclassified', metadata: at('/work/app'), projectKey: null, none: false, owner: true },
    ];
    const home = createHome(rows);
    const reclassify = createMachineSessionProjectReclassification({ credentials, machineId: 'machine-a',
      resolveHomeServerId: async () => HOME, readCandidates: home.readCandidates });
    const unrelated = ref('elsewhere', '/elsewhere', 'machine-b');
    const before = { scopeKey: 'scope', workspaceRefs: [unrelated] };
    const opened = { scopeKey: 'scope', workspaceRefs: [unrelated, ref('app', '/work/app'), ref('win', 'C:\\Work\\App')] };

    await reclassify(before, opened);
    expect(home.patches).toEqual([{ sessionId: 'exact', projectKey: 'app' }, { sessionId: 'windows', projectKey: 'win' }]);
    // Only owner-published no-Project rows are read, once per storage.
    expect(home.queries.map(query => [query.storage, query.projectKeys])).toEqual([
      ['active', { include: [], exclude: [], none: true }], ['archived', { include: [], exclude: [], none: true }]]);

    // A republished census without a change on this Machine reads and writes nothing.
    await reclassify(opened, { scopeKey: 'scope', workspaceRefs: [...opened.workspaceRefs, ref('remote', '/work/app', 'machine-b')] });
    expect(home.queries).toHaveLength(2);
    expect(home.patches).toHaveLength(2);

    // Forgetting the checkout returns its Sessions on this Machine to "no Project"; the other checkout keeps its own.
    rows.find(row => row.id === 'exact')!.metadata = at('/work/app', { workspaceId: 'app', projectId: 'app' } as Partial<Metadata>);
    rows.find(row => row.id === 'windows')!.metadata = at('c:/work/App', { workspaceId: 'win', projectId: 'win' } as Partial<Metadata>);
    rows.push({ id: 'other-machine-keyed', metadata: createTestMetadata({ path: '/work/app', machineId: 'machine-b',
      workspaceId: 'app', projectId: 'app' } as Partial<Metadata>), projectKey: 'app', none: false, owner: true });
    await reclassify(opened, { scopeKey: 'scope', workspaceRefs: [unrelated, ref('win', 'C:\\Work\\App')] });
    expect(home.patches.slice(2)).toEqual([{ sessionId: 'exact', projectKey: null }]);
    expect(home.queries.slice(2).map(query => query.projectKeys)).toEqual([{ include: ['app'], exclude: [] }, { include: ['app'], exclude: [] }]);

    // Reopening the folder joins it again through the same owner.
    rows.find(row => row.id === 'exact')!.metadata = at('/work/app');
    await reclassify({ scopeKey: 'scope', workspaceRefs: [unrelated, ref('win', 'C:\\Work\\App')] }, opened);
    expect(home.patches.slice(3)).toEqual([{ sessionId: 'exact', projectKey: 'app' }]);
  });
});
