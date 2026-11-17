import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsV2UpdateRequestSchema, decodePlainArtifactStoredContent, type ActionExecutorContext } from '@happier-dev/protocol';
import { createCliActionDeps } from './createCliActionDeps';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_RECORDS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1,
  ProfileRecordV1Schema, ProfileRowMutationV1Schema, ProfileRowsListResponseV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowsListResponseV1Schema, PromptLibraryRowMutationV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: Object.assign(actual.default.create(), actual.default, http) };
});
const artifactRows = new Map<string, Record<string, unknown>>();

describe('CLI admitted Artifact attribution', () => {
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    http.get.mockReset();
    http.post.mockReset();
    artifactRows.clear();
    let rulesRevision = 1;
    let rulesContent: unknown = { t: 'plain', v: { key: 'skill-rules', value: { v: 1, rules: [] } } };
    http.get.mockImplementation(async (url: string) => ({ status: 200, data: new URL(url).pathname === PROMPT_LIBRARY_ROWS_ROUTE_V1
      ? PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: [{ key: 'skill-rules', revision: rulesRevision, content: rulesContent }] }) : artifactRows.get(url.split('/').at(-1)!)
      ?? (url.endsWith('/v1/account/encryption/currentness') ? createAccountEncryptionCurrentnessFixture()
        : { mode: 'plain', updatedAt: 1 }) }));
    http.post.mockImplementation(async (url: string, input: Record<string, unknown>) => {
      if (new URL(url).pathname === `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`) {
        const mutation = PromptLibraryRowMutationV1Schema.parse(input);
        expect(mutation.expectedRevision).toBe(rulesRevision);
        rulesContent = mutation.content;
        rulesRevision += 1;
        return { status: 200, data: { status: 'updated', revision: rulesRevision, cursor: rulesRevision } };
      }
      artifactRows.set(String(input.id), { ...input, ownerAccountId: 'bundle-account', access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
      return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
    });
  });

  it('creates an ordinary bundle with binary supporting entries through the authenticated library owner', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bundle-account' })).toString('base64url')}.signature`;
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'bound-session', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.example.test' });
    const result = await deps.skillActionExecute!({ actionId: 'skills.create', context: { surface: 'cli' }, input: { name: 'portable-skill', files: [
      { path: 'SKILL.md', contentBase64: Buffer.from('---\nname: portable-skill\n---\nSkill').toString('base64'), contentKind: 'utf8' },
      { path: 'support.bin', contentBase64: 'AAE=', contentKind: 'binary', unixMode: 0o600 },
    ] } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, skillId: expect.any(String) });
    const write = http.post.mock.calls.find(([url]) => url.endsWith('/v1/artifacts'))?.[1];
    expect(decodePlainArtifactStoredContent(write.header)).toMatchObject({ kind: 'prompt_bundle.v2', title: 'portable-skill', origin: 'user' });
    const body = decodePlainArtifactStoredContent(write.body);
    expect(body).toMatchObject({ body: expect.any(String) });
    if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('Missing bundle body');
    expect(JSON.parse(body.body).entries).toEqual(expect.arrayContaining([
      { path: 'support.bin', contentBase64: 'AAE=', contentKind: 'binary', unixMode: 0o600 },
    ]));
    const entries = JSON.parse(body.body).entries as Array<{ path: string; contentBase64: string }>;
    expect(entries).toHaveLength(2);
    expect(Buffer.from(entries.find(entry => entry.path === 'SKILL.md')!.contentBase64, 'base64').toString('utf8'))
      .toContain('Skill');
  });

  it('keeps an admitted Launch publisher session outside public content through the real CLI dependency owner', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'launch-account' })).toString('base64url')}.signature`;
    let settings: { content: { t: 'plain'; v: Record<string, unknown> }; version: number } = { content: { t: 'plain', v: {} }, version: 1 };
    let record = ProfileRecordV1Schema.parse({ v: 1, id: 'work', enabled: true, promptStack: [], secretBindings: {},
      definition: { kind: 'inline', profile: { v: 2, id: 'work', name: 'Work', createdAt: 1, updatedAt: 1 } } });
    let revision = 1;
    let artifact: Record<string, unknown> | null = null;
    http.get.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: ProfileRowsListResponseV1Schema.parse({ status: 'listed',
        rows: [{ id: record.id, revision, content: { t: 'plain', v: record } }], nextCursor: null, complete: true,
        referenceGuardRevision: revision, transferControl: { status: 'absent' }, diagnostics: [] }) };
      if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision } };
      if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
      if (artifact && path === `/v1/artifacts/${artifact.id}`) return { status: 200, data: artifact };
      return { status: 200, data: path === '/v2/account/settings' ? settings : { mode: 'plain', updatedAt: 1 } };
    });
    http.post.mockImplementation(async (url: string, input: Record<string, unknown>) => {
      if (url.endsWith(PROFILE_RECORDS_ROUTE_V1)) {
        const mutation = ProfileRowMutationV1Schema.parse(input);
        expect(mutation.expectedRevision).toBe(revision);
        if (mutation.content?.t !== 'plain') throw new Error('Expected plain Profile record');
        record = mutation.content.v;
        revision++;
        return { status: 200, data: { status: 'updated', revision, cursor: revision, referenceGuardRevision: revision } };
      }
      if (url.endsWith('/v2/account/settings')) {
        const content = AccountSettingsV2UpdateRequestSchema.parse(input).content;
        if (content?.t !== 'plain') throw new Error('Plain Account settings boundary requires plain content');
        settings = { content, version: settings.version + 1 };
        return { status: 200, data: { success: true, version: settings.version } };
      }
      artifact = { ...input, ownerAccountId: 'launch-account', access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'bound-session', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.example.test' });
    await expect(deps.launchProfilePublish!({ profileId: 'work' }, { context: { surface: 'cli', authority: 'present_user',
      runtimeAccountId: 'untrusted-account' } })).rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
    expect(http.post).not.toHaveBeenCalled();
    await expect(deps.launchProfilePublish!({ profileId: 'work' }, { context: { surface: 'cli', authority: 'present_user',
      runtimeAccountId: 'launch-account', defaultSessionId: 'target-session',
      actionCaller: { kind: 'session', sessionId: 'admitted-launch-session', starterDepth: 0, turnDepth: 0 } } }))
      .resolves.toMatchObject({ artifactId: expect.any(String) });
    const artifactWrite = http.post.mock.calls.find(([url]) => url.endsWith('/v1/artifacts'))?.[1];
    expect(artifactWrite).toBeDefined();
    expect(decodePlainArtifactStoredContent(artifactWrite.provenance)).toMatchObject({ artifactId: artifactWrite.id,
      bodyVersion: 1, provenance: { savedBy: { kind: 'agent', accountId: 'launch-account', sessionId: 'admitted-launch-session' } } });
    expect(decodePlainArtifactStoredContent(artifactWrite.header)).not.toHaveProperty('savedBy');
    const opened = decodePlainArtifactStoredContent(artifactWrite.body);
    expect(opened).not.toHaveProperty('provenance');
    expect(record.definition).toEqual({ kind: 'artifact', artifactId: artifactWrite.id });
    expect(settings.content.v).not.toHaveProperty('profiles');
  });

  it('uses the captured Account and each admitted caller rather than a target or caller-authored body', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'captured-account' })).toString('base64url')}.signature`;
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'bound-session', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.example.test' });
    const contexts: ActionExecutorContext[] = [
      { surface: 'cli', authority: 'present_user', runtimeAccountId: 'caller-body-account', defaultSessionId: 'target-session' },
      { surface: 'agent', runtimeAccountId: 'caller-body-account', actionCaller: { kind: 'session', sessionId: 'admitted-session', starterDepth: 0, turnDepth: 0 } },
      { surface: 'agent' },
    ];
    for (const context of contexts) {
      await expect(deps.artifactAction!({ actionId: 'artifact.create', input: { header: { title: 'Result' }, body: 'No actor here' }, context }))
        .resolves.toMatchObject({ revision: { bodyVersion: 1 } });
    }
    const expected = [
      { kind: 'person', accountId: 'captured-account' },
      { kind: 'agent', accountId: 'captured-account', sessionId: 'admitted-session' },
      { kind: 'agent', accountId: 'captured-account', sessionId: 'bound-session' },
    ];
    for (const [index, call] of http.post.mock.calls.entries()) {
      expect(decodePlainArtifactStoredContent(call[1].body)).toEqual({ body: 'No actor here' });
      expect(decodePlainArtifactStoredContent(call[1].provenance)).toEqual({ v: 1, artifactId: call[1].id, bodyVersion: 1,
        provenance: { savedBy: expected[index] } });
    }
  });
});
