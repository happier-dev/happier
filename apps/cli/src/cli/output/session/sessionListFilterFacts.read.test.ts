import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchSessionListFilterV1, normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { getActiveProjectAccountRowsSnapshot, readProjectAccountRows, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import type { ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { readCliSessionListFilterFactsV1 } from './sessionListFilterFacts';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { encodeBase64, encrypt } from '@/api/encryption';
import { stringifySerializedJsonValue } from '@happier-dev/protocol/crypto/serializedJsonValue';
import { sealSessionOwnerMetadataEnvelopeV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';

const token = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
const bob = { token: token('bob'), encryption: null };
const alice = { token: token('alice'), encryption: null };
const ref = { id: 'checkout', serverId: 'home', machineId: 'alice-machine', rootPath: '/work/project', createdAtMs: 1 };
const row = createSessionRecordFixture({ id: 'source', encryptionMode: 'plain', ownerAccountId: 'bob', origin: { kind: 'none' },
  metadata: JSON.stringify({ workspaceId: ref.id, machineId: ref.machineId, path: ref.rootPath }),
  effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
    capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
const project = (projectKey: string) => normalizeSessionListFilterV1({ homeServerIds: ['home'],
  projects: { include: [{ serverId: 'home', projectKey }], exclude: [] } });
const tag = (tagId: string) => normalizeSessionListFilterV1({ homeServerIds: ['home'], tagIds: [{ serverId: 'home', tagId }] });
const all = normalizeSessionListFilterV1({ homeServerIds: ['home'], startedBy: ['you', 'agents', 'triggers'] });
afterEach(() => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot(); });

function boundary(serverId = ref.serverId, extraRows: readonly ProjectAccountRowV1[] = []) {
  const state = { projectKey: 'bob-project', tagIds: ['bob-tag'], folderId: 'section-a' as string | null, unavailable: false };
  // Only Account HTTP is substituted; row admission, snapshots and matching stay real.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } } as never;
    expect(url).toMatch(/^https:\/\/bob-home\.test\/v2\/session-organization\?/);
    expect(config?.headers?.Authorization).toBe(`Bearer ${bob.token}`);
    if (state.unavailable) return { status: 503, data: { error: 'unavailable' } } as never;
    return { status: 200, data: { snapshot: { schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: state.folderId ? [{ sessionId: row.id, folderId: state.folderId }] : [],
      tags: [], tagAssignments: [{ sessionId: row.id, tagIds: state.tagIds }], orderEntries: [], labels: [] } } } as never;
  });
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
    expect(url).toMatch(/\/v1\/account\/project-rows\/list$/);
    if (state.unavailable) return { status: 403, data: { error: 'forbidden' } } as never;
    const projectKey = config?.headers?.Authorization === `Bearer ${alice.token}` ? 'alice-project' : state.projectKey;
    return projectAccountRowsReadHttpResponse([createPlainProjectAccountRefRow({ ...ref, serverId, projectKey }), ...extraRows], url, body) as never;
  });
  return { state, get, post };
}
function input(filters = [project('bob-project'), tag('bob-tag')]) {
  return { credentials: bob, accountEncryption: createAccountEncryptionCurrentnessFixture(), row, nowMs: Date.now(),
    serverId: 'home', accountId: 'bob', serverHttpBaseUrl: 'https://bob-home.test', signal: new AbortController().signal,
    isCurrent: async () => true, filters };
}

describe('captured Account current filter facts', () => {
  it.each(['plain', 'e2ee'] as const)('opens source metadata once within one facts preparation (%s)', async mode => {
    const secret = new Uint8Array(32).fill(7);
    const metadata = JSON.stringify({ machineId: 'facts-machine', path: '/facts-source', flavor: 'codex' });
    const serialized = mode === 'plain' ? metadata : stringifySerializedJsonValue(JSON.parse(metadata));
    const captured = { ...input([all]),
      credentials: mode === 'plain' ? bob : { token: bob.token, encryption: { type: 'legacy' as const, secret } },
      accountEncryption: createAccountEncryptionCurrentnessFixture({ mode }),
      row: { ...row, encryptionMode: mode, metadata: mode === 'plain' ? metadata
        : encodeBase64(encrypt(secret, 'legacy', JSON.parse(metadata)), 'base64') },
    };
    // Transparent observation of the JSON boundary; encryption, admission,
    // metadata views, awareness and matching all execute their real logic.
    const parse = vi.spyOn(JSON, 'parse');
    const facts = await readCliSessionListFilterFactsV1(captured);
    expect(facts).toMatchObject({ machine: { serverId: 'home', machineId: 'facts-machine' },
      agent: 'agent:happier.agent.codex/codex', source: 'persisted' });
    expect(parse.mock.calls.filter(([text]) => text === serialized)).toHaveLength(1);
    parse.mockClear();
    expect(await readCliSessionListFilterFactsV1(captured)).not.toBeNull();
    expect(parse.mock.calls.filter(([text]) => text === serialized), 'the next preparation must open its own current source').toHaveLength(1);
  });
  it('carries one opened layout-one owner view without losing shared content on an Account-mode refusal', async () => {
    const secret = new Uint8Array(32).fill(7);
    const ownerMetadata = sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
      ownerMetadata: SessionOwnerMetadataV1Schema.parse({ v: 1,
        workspace: { machineId: 'facts-private-machine', path: '/private/facts' } }),
      randomBytes: length => new Uint8Array(length).fill(3) });
    // Session and owner envelopes have separate mode authorities.
    const captured = { ...input([all]), credentials: { token: bob.token, encryption: { type: 'legacy' as const, secret } },
      accountEncryption: createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }),
      row: { ...row, metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), ownerMetadata } };
    const parse = vi.spyOn(JSON, 'parse');
    const facts = await readCliSessionListFilterFactsV1(captured);
    expect(facts?.machine).toEqual({ serverId: 'home', machineId: 'facts-private-machine' });
    expect(parse.mock.calls.filter(([text]) => text.includes('facts-private-machine'))).toHaveLength(1);
    const refused = await readCliSessionListFilterFactsV1({ ...captured,
      credentials: bob, accountEncryption: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) });
    expect(refused?.machine).toBeUndefined();
    expect(refused?.projectMetadata).toBeNull();
    expect(refused?.metadata).toEqual({ v: 1 });
  });
  it('reads only same-Home refs once per demanded cycle, regardless of the Account census, and observes moves', async () => {
    const organizations: ProjectAccountRowV1[] = Array.from({ length: 1024 }, (_, index) => {
      const key = { kind: 'project-organization' as const, serverId: 'home', projectKey: `other-${index}` };
      return { key, revision: 0, content: { t: 'plain', v: { key, value: {} } } };
    });
    const { state, post } = boundary('home', [...organizations,
      createPlainProjectAccountRefRow({ ...ref, serverId: 'other-home', projectKey: 'foreign-project' })]);
    for (const projectKey of ['bob-project', 'moved-project']) {
      state.projectKey = projectKey;
      const facts = await readCliSessionListFilterFactsV1(input([project(projectKey)]));
      expect(matchSessionListFilterV1(project(projectKey), facts!)).toBe('match');
    }
    expect(post.mock.calls.map(([, body]) => body)).toEqual([
      { kinds: ['workspace-ref'], serverId: 'home' }, { kinds: ['workspace-ref'], serverId: 'home' },
    ]);
    expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
  });
  it.each([
    { stamped: 'checkout', included: ['bob-project'], excluded: [], expected: 'match' },
    { stamped: 'checkout', included: [], excluded: ['bob-project'], expected: 'miss' },
    { stamped: 'checkout', included: ['checkout'], excluded: [], expected: 'miss' },
  ])('matches stamped Project keys through current membership ($included / $excluded)', async ({ stamped, included, excluded, expected }) => {
    const { post } = boundary();
    const filter = normalizeSessionListFilterV1({ ...all, projects: {
      include: included.map(projectKey => ({ serverId: 'home', projectKey })),
      exclude: excluded.map(projectKey => ({ serverId: 'home', projectKey })),
    } });
    const facts = await readCliSessionListFilterFactsV1({ ...input([filter]), row: { ...row, projectKey: stamped } });
    expect(matchSessionListFilterV1(filter, facts!)).toBe(expected);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('uses a published Project relationship without private reads when no Project predicate demands membership', async () => {
    const { get, post } = boundary();
    const facts = await readCliSessionListFilterFactsV1({ ...input([all]),
      row: { ...row, projectKey: 'bob-project', metadata: 'unavailable' } });
    expect(matchSessionListFilterV1(project('bob-project'), facts!)).toBe('match');
    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
  it('reads Section-only demand from one existing placement batch, preserving missing versus known-empty', async () => {
    const { state, get, post } = boundary();
    const section = normalizeSessionListFilterV1({ ...all, sections: { include: [{ serverId: 'home', sectionId: 'section-a' }], exclude: [] } });
    const facts = await readCliSessionListFilterFactsV1(input([section]));
    expect(facts?.section).toEqual({ serverId: 'home', sectionId: 'section-a' });
    expect(matchSessionListFilterV1(section, facts!, 'daemonRule')).toBe('match');
    expect(get.mock.calls.filter(([url]) => new URL(url).pathname === '/v2/session-organization')).toHaveLength(1);
    expect(post).not.toHaveBeenCalled();
    state.folderId = null;
    const empty = await readCliSessionListFilterFactsV1(input([section]));
    expect(empty?.section).toBeNull();
    expect(matchSessionListFilterV1(section, empty!, 'daemonRule')).toBe('miss');
    state.unavailable = true;
    const unavailable = await readCliSessionListFilterFactsV1(input([section]));
    expect(unavailable?.section).toBeUndefined();
    expect(matchSessionListFilterV1(section, unavailable!, 'daemonRule')).toBe('unavailable');
  });
  it('does not read supplemental Project or tag facts for predicates already excluded by known Session facts', async () => {
    const { get, post } = boundary();
    const excluded = normalizeSessionListFilterV1({ ...project('bob-project'), show: 'runs',
      tagIds: [{ serverId: 'home', tagId: 'bob-tag' }] });
    const facts = await readCliSessionListFilterFactsV1(input([excluded]));
    expect(facts).not.toBeNull();
    expect(matchSessionListFilterV1(excluded, facts!)).toBe('miss');
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
  it('still reads current supplemental facts for eligible predicates alongside known misses', async () => {
    const { get, post } = boundary();
    const excluded = normalizeSessionListFilterV1({ ...tag('bob-tag'), show: 'runs' });
    const eligible = project('bob-project');
    const facts = await readCliSessionListFilterFactsV1(input([excluded, eligible]));
    expect(matchSessionListFilterV1(excluded, facts!)).toBe('miss');
    expect(matchSessionListFilterV1(eligible, facts!)).toBe('match');
    expect(post).toHaveBeenCalledTimes(1);
    expect(get.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/v1/account/encryption']);
  });
  it.each(['portable', 'local'] as const)('reads portable Project and tag facts from a captured local Home profile (%s filter)', async qualifier => {
    await withConfiguredDaemonTestHome({ prefix: 'follow-facts-portable-home-' }, async () => {
      const profileId = 'stack_agent-qa-coord-n1__id_default';
      const homeId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
      await seedTestServerProfile({ id: profileId, homeId, serverUrl: 'https://bob-home.test' });
      boundary(homeId, [createPlainProjectAccountRefRow({ ...ref, serverId: profileId, projectKey: 'old-local-project' })]);
      const filterHome = qualifier === 'local' ? profileId : homeId;
      const projectFilter = normalizeSessionListFilterV1({ homeServerIds: [filterHome],
        projects: { include: [{ serverId: filterHome, projectKey: 'bob-project' }], exclude: [] } });
      const tagFilter = normalizeSessionListFilterV1({ homeServerIds: [filterHome], tagIds: [{ serverId: filterHome, tagId: 'bob-tag' }] });
      const facts = await readCliSessionListFilterFactsV1({ ...input([projectFilter, tagFilter]), serverId: profileId });
      expect(facts?.serverId).toBe(homeId);
      expect(matchSessionListFilterV1(projectFilter, facts!)).toBe('match');
      expect(matchSessionListFilterV1(tagFilter, facts!)).toBe('match');
      expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
    });
  });
  it('reads Bob current Project and tags without borrowing or publishing Alice installed rows, then observes moves', async () => {
    const { state } = boundary();
    const installed = await readProjectAccountRows({ credentials: alice, serverId: 'home', publication: 'installed' });
    const facts = await readCliSessionListFilterFactsV1(input());
    expect(facts).not.toBeNull();
    expect(matchSessionListFilterV1(project('bob-project'), facts!)).toBe('match');
    expect(matchSessionListFilterV1(tag('bob-tag'), facts!)).toBe('match');
    expect(matchSessionListFilterV1(project('alice-project'), facts!)).toBe('miss');
    expect(getActiveProjectAccountRowsSnapshot()).toBe(installed);
    state.projectKey = 'moved-project';
    state.tagIds = ['new-tag'];
    const moved = await readCliSessionListFilterFactsV1(input());
    expect(matchSessionListFilterV1(project('bob-project'), moved!)).toBe('miss');
    expect(matchSessionListFilterV1(project('moved-project'), moved!)).toBe('match');
    expect(matchSessionListFilterV1(tag('bob-tag'), moved!)).toBe('miss');
    expect(matchSessionListFilterV1(tag('new-tag'), moved!)).toBe('match');
  });
  it('keeps denied supplemental facts unavailable without suppressing unrelated predicates or borrowing installed rows', async () => {
    const { state } = boundary();
    const installed = await readProjectAccountRows({ credentials: alice, serverId: 'home', publication: 'installed' });
    state.unavailable = true;
    const facts = await readCliSessionListFilterFactsV1(input());
    expect(matchSessionListFilterV1(project('bob-project'), facts!)).toBe('unavailable');
    expect(matchSessionListFilterV1(tag('bob-tag'), facts!)).toBe('unavailable');
    expect(matchSessionListFilterV1(all, facts!)).toBe('match');
    expect(getActiveProjectAccountRowsSnapshot()).toBe(installed);
  });
  it('distinguishes a complete empty tag assignment from unavailable and performs no supplemental read without demand', async () => {
    const { state, get, post } = boundary();
    state.tagIds = [];
    const facts = await readCliSessionListFilterFactsV1(input([tag('bob-tag')]));
    expect(facts?.tagIds).toEqual([]);
    expect(matchSessionListFilterV1(tag('bob-tag'), facts!)).toBe('miss');
    get.mockClear(); post.mockClear();
    expect(await readCliSessionListFilterFactsV1(input([all]))).not.toBeNull();
    expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });
  it('does not accept another Account credential or a scope retired during private reads', async () => {
    const { get, post } = boundary();
    expect(await readCliSessionListFilterFactsV1({ ...input(), credentials: alice })).toBeNull();
    expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
    let current = true;
    const implementation = post.getMockImplementation()!;
    post.mockImplementation(async (...args) => { const result = await implementation(...args); current = false; return result; });
    expect(await readCliSessionListFilterFactsV1({ ...input(), isCurrent: async () => current })).toBeNull();
  });
  it('opens selected refs in the captured E2EE mode and refuses mode mismatch', async () => {
    const { get, post } = boundary();
    get.mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } });
    const secret = new Uint8Array(32).fill(7);
    const credentials = { token: bob.token, encryption: { type: 'legacy' as const, secret } };
    const cipher = createProjectAccountRowCipherV1({ mode: 'e2ee', material: { type: 'legacy', secret },
      randomBytes: n => new Uint8Array(n).fill(3) });
    const key = { kind: 'workspace-ref' as const, serverId: ref.serverId, id: ref.id };
    let encrypted = true;
    post.mockImplementation(async (url, body) => projectAccountRowsReadHttpResponse([{ key, revision: 1,
      content: encrypted ? cipher.seal({ key, value: { ...ref, projectKey: 'bob-project' } })
        : { t: 'plain', v: { key, value: { ...ref, projectKey: 'bob-project' } } } }], url, body));
    const captured = { ...input([project('bob-project')]), credentials };
    expect(matchSessionListFilterV1(project('bob-project'), (await readCliSessionListFilterFactsV1(captured))!)).toBe('match');
    encrypted = false;
    expect(matchSessionListFilterV1(project('bob-project'), (await readCliSessionListFilterFactsV1(captured))!)).toBe('unavailable');
    expect(post.mock.calls.every(([, body]) => JSON.stringify(body) === JSON.stringify({ kinds: ['workspace-ref'], serverId: 'home' }))).toBe(true);
  });
  it('carries cancellation through the selected read and accepts no late facts', async () => {
    const { post } = boundary();
    const controller = new AbortController();
    const serve = post.getMockImplementation()!;
    post.mockImplementation(async (...args) => {
      expect(args[2]?.signal).toBe(controller.signal);
      const result = await serve(...args);
      controller.abort();
      return result;
    });
    expect(await readCliSessionListFilterFactsV1({ ...input([project('bob-project')]), signal: controller.signal })).toBeNull();
    expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
  });
});
