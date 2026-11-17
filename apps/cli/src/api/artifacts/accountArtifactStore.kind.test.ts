import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { decodeArtifactUploadMetadataV1 } from '@happier-dev/transfers';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { ArtifactKindCoverageV1Schema } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { createAccountArtifactStore, encodeAccountArtifactListCursor } from './accountArtifactStore';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: { get, post, defaults: {} } }));

const skillHeader = { v: 1, kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1', title: 'Skill' };
const skillBody = JSON.stringify({ v: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
  contentBase64: Buffer.from('---\nname: sample\ndescription: useful\n---\nInstructions').toString('base64') }], createdAtMs: 1, updatedAtMs: 1 });
const artifactId = '11111111-1111-4111-8111-111111111111';
function row(id: string, header: Readonly<Record<string, unknown>>, updatedAt: number) {
  return { id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent(header),
    body: encodePlainArtifactStoredContent({ body: 'original' }), headerVersion: 1, bodyVersion: 1,
    seq: updatedAt, createdAt: updatedAt, updatedAt };
}
function store(supported = true) {
  const input = { credentials: { token: 'synthetic-token', encryption: null },
    getAccountEncryptionMode: async () => 'plain' as const,
    resolveServerFeaturesSnapshot: () => ({ status: 'ready' as const, features: FeaturesResponseSchema.parse({
      features: { artifacts: { queryHints: { enabled: supported } } }, capabilities: {},
    }) }) };
  return createAccountArtifactStore(input);
}
describe('Account Artifact coarse kind transport', () => {
  beforeEach(() => { get.mockReset(); post.mockReset(); });

  it('pages an admitted locked Team row without opening Account content material', async () => {
    const getAccountEncryptionMode = vi.fn(async () => 'e2ee' as const);
    const artifacts = createAccountArtifactStore({ credentials: { token: 'synthetic-token', encryption: null },
      getAccountEncryptionMode });
    get.mockResolvedValue({ status: 200, data: { items: [{ id: artifactId, ownerAccountId: 'another-owner',
      access: 'view', publicAudience: 'none', encryptionMode: 'e2ee', kind: null, sharedWithTeamScope: 'group',
      availability: { kind: 'locked', reason: 'encryption_material_unavailable' },
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }],
      hasUnclassified: false, coverage: { status: 'complete', unclassifiedCount: 0 } } });
    const page = await artifacts.list({ sharedWithTeamId: 'team-a', teamResourceKind: 'otherArtifacts', limit: 1 });
    expect(page.items).toEqual([expect.objectContaining({ artifactId, header: {}, sharedWithTeamScope: 'group',
      availability: { kind: 'locked', reason: 'encryption_material_unavailable' } })]);
    expect(page.nextCursor).toBeDefined();
    expect(page.coverage).toBe('partial');
    expect(getAccountEncryptionMode).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
    const query = new URL(get.mock.calls[0]![0]).searchParams;
    expect(Object.fromEntries(query)).toMatchObject({ sharedWithTeamId: 'team-a', teamResourceKind: 'otherArtifacts', limit: '1' });
    expect(query.has('includeBody')).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('preserves the Team bucket owner unavailable refusal at the CLI receiver', async () => {
    get.mockResolvedValue({ status: 503, data: { error: 'artifact_content_unavailable' } });
    await expect(store().list({ sharedWithTeamId: 'team-a', teamResourceKind: 'projectDocuments' }))
      .rejects.toMatchObject({ code: 'artifact_content_unavailable', status: 503 });
  });

  it('reads received templates as one header page without legacy or body demand', async () => {
    const selected = { ...row(artifactId, { kind: 'bot_template.v1', title: 'Received' }, 1), access: 'view' };
    const header = { ...selected };
    Reflect.deleteProperty(header, 'body');
    get.mockResolvedValue({ status: 200, data: { items: [header], hasUnclassified: true,
      coverage: { status: 'partial', unclassifiedCount: 1, reason: 'unclassified_legacy_rows' } } });
    const options = { audience: 'received' as const, kinds: ['bot_template.v1'], limit: 1 };
    const page = await store().list(options);
    expect(page.items.map(item => item.artifactId)).toEqual([artifactId]);
    expect(page.coverage).toBe('partial');
    expect(get).toHaveBeenCalledTimes(1);
    const query = new URL(get.mock.calls[0]![0]).searchParams;
    expect(query.get('audience')).toBe('received');
    expect(query.get('limit')).toBe('1');
    expect(query.has('includeBody')).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('retains admitted Team audience through list, selected header and exact body reads', async () => {
    const shared = { ...row(artifactId, { kind: 'workflow-definition.v1', title: 'Review' }, 1), sharedTeamIds: ['team-a'] };
    const header = { ...shared };
    Reflect.deleteProperty(header, 'body');
    get.mockImplementation(async (url: string) => ({ status: 200, data: new URL(url).pathname === '/v1/artifacts' ? [shared] : shared }));
    post.mockResolvedValue({ status: 200, data: { projection: 'headers', items: [{ artifactId, ok: true, artifact: header }] } });
    const artifacts = store();
    expect((await artifacts.list({})).items[0]).toMatchObject({ artifactId, sharedTeamIds: ['team-a'] });
    expect(await artifacts.readHeader(artifactId)).toMatchObject({ artifactId, sharedTeamIds: ['team-a'] });
    expect(await artifacts.read(artifactId)).toMatchObject({ artifactId, sharedTeamIds: ['team-a'] });
  });

  it('commits approval state and Session identity with each header transition', async () => {
    const open = { kind: 'approval_request.v1', title: 'Private review', approvalStatus: 'open', sessionId: 'session-1' };
    get.mockResolvedValue({ status: 200, data: row(artifactId, open, 1) });
    post.mockResolvedValue({ status: 200, data: { id: artifactId, success: true, headerVersion: 2, bodyVersion: 2 } });
    const artifacts = store();
    await artifacts.create({ artifactId, header: open, body: 'private open request' });
    await artifacts.update({ artifactId, header: { ...open, approvalStatus: 'executed' }, body: 'private receipt',
      expectedRevision: { headerVersion: 1, bodyVersion: 1 } });
    expect(post.mock.calls.map(([, wire]) => ({ approvalState: wire.approvalState, approvalSessionId: wire.approvalSessionId })))
      .toEqual([{ approvalState: 'open', approvalSessionId: 'session-1' }, { approvalState: 'executed', approvalSessionId: 'session-1' }]);
  });

  it('sends classification for create, update, binary upload and restore', async () => {
    const current = { ...row(artifactId, skillHeader, 1), body: encodePlainArtifactStoredContent({ body: skillBody }) };
    get.mockImplementation(async (url: string) => ({ status: 200, data: new URL(url).pathname.endsWith('/revisions')
      ? { revisions: [{ bodyVersion: 1, body: current.body, createdAt: 1, sizeBytes: 8 }], retentionCount: 10 }
      : current }));
    post.mockImplementation(async (_url: string, input: unknown) => {
      const wire = Buffer.isBuffer(input)
        ? decodeArtifactUploadMetadataV1(input.subarray(0, input.indexOf(10)))
        : input;
      expect(wire).toEqual(expect.objectContaining(Buffer.isBuffer(input)
        ? { artifactKind: 'v1:other:ordinary.v1' } : { kind: 'v1:skill:prompt_bundle.v2' }));
      return { status: 200, data: { id: artifactId, success: true, headerVersion: 2, bodyVersion: 2 } };
    });
    const artifacts = store();
    await artifacts.create({ artifactId, header: skillHeader, body: skillBody });
    await artifacts.update({ artifactId, header: skillHeader, body: skillBody, expectedRevision: { headerVersion: 1, bodyVersion: 1 } });
    await artifacts.create({ artifactId, header: { kind: 'ordinary.v1' }, binary: { bytes: new Uint8Array([1, 2]), mime: 'application/octet-stream' } });
    await artifacts.update({ artifactId, header: { kind: 'ordinary.v1' }, binary: { bytes: new Uint8Array([3, 4]), mime: 'application/octet-stream' },
      expectedRevision: { headerVersion: 1, bodyVersion: 1 } });
    await expect(artifacts.revisions.restore({ artifactId, bodyVersion: 1, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }))
      .resolves.toMatchObject({ ok: true });
    expect(post).toHaveBeenCalledTimes(5);
  });

  it('omits unsupported optional hints on normal create, update, binary upload and restore without refusing content', async () => {
    const current = { ...row(artifactId, skillHeader, 1), body: encodePlainArtifactStoredContent({ body: skillBody }) };
    get.mockImplementation(async (url: string) => ({ status: 200, data: new URL(url).pathname.endsWith('/revisions')
      ? { revisions: [{ bodyVersion: 1, body: current.body, createdAt: 1, sizeBytes: 8 }], retentionCount: 10 } : current }));
    post.mockImplementation(async (_url: string, input: unknown) => {
      const upload = Buffer.isBuffer(input);
      const wire = upload ? decodeArtifactUploadMetadataV1(input.subarray(0, input.indexOf(10))) : input;
      expect(wire).not.toHaveProperty(upload ? 'artifactKind' : 'kind');
      return { status: 200, data: { id: artifactId, success: true, headerVersion: 2, bodyVersion: 2 } };
    });
    const artifacts = store(false);
    await artifacts.create({ artifactId, header: skillHeader, body: skillBody });
    await expect(artifacts.update({ artifactId, header: skillHeader, body: skillBody, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }))
      .resolves.toMatchObject({ ok: true });
    await artifacts.create({ artifactId, header: { kind: 'ordinary.v1' }, binary: { bytes: new Uint8Array([1, 2]), mime: 'application/octet-stream' } });
    await expect(artifacts.update({ artifactId, header: { kind: 'ordinary.v1' }, binary: { bytes: new Uint8Array([3, 4]), mime: 'application/octet-stream' },
      expectedRevision: { headerVersion: 1, bodyVersion: 1 } })).resolves.toMatchObject({ ok: true });
    await expect(artifacts.revisions.restore({ artifactId, bodyVersion: 1, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }))
      .resolves.toMatchObject({ ok: true });
    expect(post).toHaveBeenCalledTimes(5);
  });

  it('preserves private content when a supported optional discriminator cannot fit its metadata column', async () => {
    const header = { kind: 'x'.repeat(192), title: 'Private content remains valid' };
    const current = row(artifactId, header, 1);
    get.mockResolvedValue({ status: 200, data: current });
    post.mockImplementation(async (_url: string, wire: unknown) => {
      expect(wire).not.toHaveProperty('kind');
      return { status: 200, data: { id: artifactId, success: true, headerVersion: 2, bodyVersion: 2 } };
    });
    const artifacts = store();
    await expect(artifacts.create({ artifactId, header, body: 'Private body' })).resolves.toMatchObject({ artifactId });
    await expect(artifacts.update({ artifactId, header, body: 'Private body', expectedRevision: { headerVersion: 1, bodyVersion: 1 } }))
      .resolves.toMatchObject({ ok: true });
  });

  it('reads only classified skill pages and retains filtered pagination', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => row(`skill-${i}`, skillHeader, 501 - i));
    const queries: URLSearchParams[] = [];
    get.mockImplementation(async (url: string) => {
      const query = new URL(url).searchParams;
      queries.push(query);
      if (query.has('unclassified')) return { status: 200, data: { items: [], hasUnclassified: false } };
      expect(query.get('kind')).toBe('skill');
      return { status: 200, data: { items: query.has('cursor') ? rows.slice(500) : rows.slice(0, 500), hasUnclassified: false } };
    });
    const page = await store().list({ coarseKind: 'skill', limit: 1 });
    expect(page.items.map(item => item.artifactId)).toEqual(['skill-0']);
    expect(page.coverage).toBe('complete');
    expect(page.nextCursor).toBe(encodeAccountArtifactListCursor({ artifactId: 'skill-0', updatedAt: 501 }));
    expect(queries).toHaveLength(1);
  });

  it('merges readable legacy skill headers before paging without metadata writes or an inventory fallback', async () => {
    const known = row('known', skillHeader, 1);
    const newerLegacy = row('unclassified', skillHeader, 502);
    const kinds: Array<string | null> = [];
    get.mockImplementation(async (url: string) => {
      const query = new URL(url).searchParams;
      kinds.push(query.get('kind') ?? query.get('unclassified'));
      expect(query.has('kind') || query.has('unclassified')).toBe(true);
      expect(query.has('includeBody')).toBe(false);
      return { status: 200, data: { items: query.has('unclassified') ? [newerLegacy] : [known], hasUnclassified: true,
        coverage: ArtifactKindCoverageV1Schema.parse({ status: 'partial', unclassifiedCount: 1, reason: 'unclassified_legacy_rows' }) } };
    });
    post.mockResolvedValue({ status: 409, data: { success: false, error: 'version-mismatch' } });
    const artifacts = store();
    const first = await artifacts.list({ coarseKind: 'skill', limit: 1 });
    expect(first.items.map(item => item.artifactId)).toEqual(['unclassified']);
    expect(first.items[0]).not.toHaveProperty('body');
    expect(first.nextCursor).toBe(encodeAccountArtifactListCursor({ artifactId: 'unclassified', updatedAt: 502 }));
    expect(first.coverage).toBe('complete');
    expect(first.kindCoverage?.status).toBe('partial');
    expect(kinds).toEqual(['skill', 'coarse']);
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses a filtered response that omits its completeness witness', async () => {
    get.mockResolvedValue({ status: 200, data: { items: [] } });
    await expect(store().list({ coarseKind: 'skill', limit: 1 })).rejects.toMatchObject({ code: 'list_failed' });
  });

  it('refuses an unfiltered response missing authenticated Artifact authority', async () => {
    // Retained ciphertext from server-v0.2.16-preview.1
    // (22ac8263cfdbcdb845441b9044ff18199cf7652e) is valid stored data.
    // Missing current Home authority must still be refused before opening it.
    get.mockImplementation(async (url: string) => {
      expect(new URL(url).searchParams.has('kind')).toBe(false);
      return { status: 200, data: [{ id: 'retained-0.2',
        header: 'AAEBAQEBAQEBAQEBAQ3D1uj43px+uLGuchVFGVDEkm6RfN1IfDZnIg4T0WCK4Ih8wul2qaIqCzhu40TM8/10hyBxnIk+zjfCKuxZp+HAkzJVLPYUHU1qOQ7EUGS6LvI+dmsnbtYcvYynDW3Ibd9W',
        dataEncryptionKey: 'AKwBsiCehjVPuFMje13g9PqxPH/L9DOmHAGTaWF/7PELBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEFp2vL9F4qtFp456Ip/CLBk3sduq0hPJdydpvcpyDvxcC/u5pBQ8RJx6w/6IzrX2B',
        headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }] };
    });
    await expect(store().list({ limit: 1 }))
      .rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
  });
});
