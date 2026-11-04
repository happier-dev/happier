import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '../../actions/actionExecutor.js';
import { createWorkBoardArtifactBoundary } from '../../boards/workBoardArtifactV1.testkit.js';
import { createBotTemplateActionExecuteV1, listSharedBotTemplateSummariesV1 } from './botTemplateOperations.js';
import { listArtifactHeadersV1 } from '../../artifacts/artifactListSelectionV1.js';
import { normalizeActionsSettingsV1 } from '../../actions/actionSettings.js';
import { projectBotTemplateArtifactHeaderV1 } from './botTemplateV1.js';
import type { BotTemplateActionIdV1 } from './botTemplateActionsV1.js';
import type { BotTemplateOperationPortV1 } from './botTemplateOperations.js';

const sourceSessionRef = { serverId: 'home', sessionId: 'source-bot' };
const content = { v: 1 as const, identity: { name: 'Helper', description: 'Reusable helper' }, instructions: { markdown: 'Help with work.' },
  memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } };
const draftId = '7e23f798-230a-42f3-931f-e38b20736333';
const releaseId = '84a6bc9c-0418-44f6-a593-8a751bde13e0';
function fixture(options?: { grant?: () => Promise<void>; signedInLink?: BotTemplateOperationPortV1['signedInLink']; ownerDisplayName?: string | null;
  resolvePluginRelease?: BotTemplateOperationPortV1['resolvePluginRelease'] }) {
  const boundary = createWorkBoardArtifactBoundary();
  const events: string[] = [];
  let sourceRef: { serverId: string; artifactId: string } | null = null;
  const ids = [draftId, releaseId];
  const transport = boundary.forAccount('author');
  const execute = createBotTemplateActionExecuteV1({
    artifacts: { ...transport,
      read: async (id, readOptions) => {
        const row = await transport.read(id, readOptions);
        return row ? { ...row, ...(options?.ownerDisplayName === undefined ? {} : { ownerDisplayName: options.ownerDisplayName }) } : null;
      },
      create: async input => { events.push(`create:${input.artifactId}`); return transport.create(input); } },
    randomId: () => ids.shift()!, nowMs: () => 100,
    readSourceDraftRef: async () => sourceRef,
    writeSourceDraftRef: async (_source, value) => { sourceRef = value; events.push(`ref:${value.artifactId}`); },
    grant: async input => { events.push(`grant:${input.artifactId}:${input.accessLevel}`); await options?.grant?.(); },
    ...(options?.signedInLink ? { signedInLink: options.signedInLink } : {}),
    ...(options?.resolvePluginRelease ? { resolvePluginRelease: options.resolvePluginRelease } : {}),
  });
  const executor = createActionExecutor({ botTemplateAction: args => execute(args), prepareBotTemplateRelease: execute.prepareRelease });
  const run = (id: BotTemplateActionIdV1, input: unknown) => executor.execute(id, input,
    { surface: 'ui', serverId: 'home', authority: 'present_user',
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {} }), presentUserConfirmation: { actionId: id } });
  return { boundary, events, run };
}

describe('template Actions through the executor', () => {
  it('retains explicit UI snapshot CAS and refuses a different draft for the same Bot', async () => {
    const f = fixture();
    await f.run('template.draft', { sourceSessionRef, content });
    const reviewed = { sourceSessionRef, content, expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
    expect(await f.run('template.draft', reviewed)).toMatchObject({ ok: true, result: {
      draftArtifactId: draftId, revision: { headerVersion: 2, bodyVersion: 2 },
    } });
    const current = f.boundary.rows.get(draftId);
    expect(await f.run('template.draft', { ...reviewed, content: { ...content, instructions: { markdown: 'Stale edit' } } }))
      .toMatchObject({ ok: false, errorCode: 'version_mismatch' });
    expect(f.boundary.rows.get(draftId)).toEqual(current);
    expect(await f.run('template.draft', { ...reviewed, draftArtifactId: releaseId }))
      .toMatchObject({ ok: false, errorCode: 'invalid_request' });
    expect(f.boundary.rows.size).toBe(1);
  });
  it('returns a typed admission failure when the signed-in release draft is missing', async () => {
    const f = fixture({ signedInLink: async () => {} });
    await expect(f.run('template.release', { draftArtifactId: draftId, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      version: '1.0.0', changelog: '', share: { recipients: [], signedInLink: true } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'artifact_not_found' });
    expect(f.events).toEqual([]);
  });
  it('refuses a signed-in release without transient delivery before writing or granting', async () => {
    const f = fixture();
    await f.run('template.draft', { sourceSessionRef, content });
    const before = [...f.events];
    expect(await f.run('template.release', { draftArtifactId: draftId, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      version: '1.0.0', changelog: '', share: { recipients: [{ kind: 'account', accountId: 'recipient' }], signedInLink: true } }))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(f.events).toEqual(before);
  });
  it('shares a reviewed release with Team principals and a signed-in link through the parent operation', async () => {
    const links: string[] = [];
    const f = fixture({ signedInLink: async ({ artifactId }) => { links.push(artifactId); } });
    await f.run('template.draft', { sourceSessionRef, content });
    const result = await f.run('template.release', { draftArtifactId: draftId, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      version: '1.0.0', changelog: '', share: { recipients: [{ kind: 'team', teamId: 'team' }], signedInLink: true } });
    expect(result).toMatchObject({ ok: true, result: { artifactId: releaseId } });
    expect(links).toEqual([releaseId]);
    expect(f.events).toContain(`grant:${releaseId}:view`);
  });
  it('projects received released summaries from one structural page and keeps sparse query continuation', async () => {
    const calls: unknown[] = [];
    const header = { v: 1, kind: 'bot_template.v1', state: 'released', title: 'Garden',
      description: 'Native plants', version: '1.2.3', changelog: '' };
    const items = [
      { artifactId: 'released', header, ownerAccountId: 'author', ownerDisplayName: 'Maya', createdAt: 1, updatedAt: 3 },
      { artifactId: 'draft', header: { v: 1, kind: 'bot_template.v1', state: 'draft', title: 'Draft', description: '' }, ownerAccountId: 'author', createdAt: 1, updatedAt: 2 },
      { artifactId: 'unknown-author', header: { ...header, title: 'Tree' }, ownerAccountId: 'other', createdAt: 1, updatedAt: 1 },
    ];
    const list: Parameters<typeof listSharedBotTemplateSummariesV1>[0]['list'] = options => listArtifactHeadersV1({ options,
      encodeCursor: item => item.artifactId, readPage: async request => { calls.push(request);
        return { items, nextCursor: 'unknown-author', kindCoverage: { status: 'complete', unclassifiedCount: 0 } }; } });
    const result = await listSharedBotTemplateSummariesV1({ serverId: 'home', list, limit: 3 });
    expect(result.items).toEqual([
      { source: { kind: 'artifact', serverId: 'home', artifactId: 'released' }, ownerAccountId: 'author', ownerDisplay: 'Maya',
        identity: { name: 'Garden', description: 'Native plants' }, version: '1.2.3' },
      { source: { kind: 'artifact', serverId: 'home', artifactId: 'unknown-author' }, ownerAccountId: 'other', ownerDisplay: null,
        identity: { name: 'Tree', description: 'Native plants' }, version: '1.2.3' },
    ]);
    expect(result.nextCursor).toBe('unknown-author');
    expect(calls).toEqual([{ audience: 'received', kinds: ['bot_template.v1'], limit: 3 }]);
    const searched = await listSharedBotTemplateSummariesV1({ serverId: 'home', list, limit: 3, query: 'absent' });
    expect(searched).toMatchObject({ items: [], nextCursor: 'unknown-author', coverage: 'complete' });
    expect((await listSharedBotTemplateSummariesV1({ serverId: 'home', list, query: 'plants' })).items).toHaveLength(2);
  });
  it('does not invent Artifact owner or sharing facts for a plugin release', async () => {
    const release = { v: 1 as const, version: '1.0.0', releasedAtMs: 1, changelog: '',
      content: { ...content, identity: { ...content.identity, madeFromName: 'Carried source name' } } };
    const f = fixture({ resolvePluginRelease: async source => ({ source, release }) });
    const source = { kind: 'plugin', registryItem: { sourceId: 'npm', itemId: 'helper', version: '1.0.0' }, contributionId: 'template' };
    const result = await f.run('template.preview', { source });
    expect(result).toMatchObject({ ok: true, result: { release } });
    if (result.ok) expect(result.result).not.toHaveProperty('presentation');
    expect(f.boundary.reads).toEqual([]);
  });
  it.each(['Maya Rowan', null, undefined])('previews only admitted owner presentation, without treating carried identity as authorship (%s)', async ownerDisplayName => {
    const f = fixture({ ownerDisplayName });
    const authored = { ...content, identity: { ...content.identity, name: 'Carried Bot name', madeFromName: 'Carried source name' } };
    await f.run('template.draft', { sourceSessionRef, content: authored });
    await f.run('template.release', { draftArtifactId: draftId, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      version: '1.2.3', changelog: '' });
    const reads = f.boundary.reads.length;
    const result = await f.run('template.preview', { source: { kind: 'artifact', serverId: 'home', artifactId: releaseId } });
    expect(result).toMatchObject({ ok: true, result: { release: { version: '1.2.3' },
      presentation: { shared: false, ...(ownerDisplayName === undefined ? {} : { ownerDisplayName }) } } });
    if (result.ok) expect(Reflect.get(result.result as object, 'presentation')).toEqual({ shared: false,
      ...(ownerDisplayName === undefined ? {} : { ownerDisplayName }) });
    expect(f.boundary.reads.slice(reads)).toEqual([releaseId]);
  });
  it('downloads the exact binary companion without creating recipient content', async () => {
    const f = fixture();
    const portable = { ...content, skills: [{ key: 'guide', title: 'Guide', bundleSchemaId: 'skills.skill_md_v1', entries: [
      { path: 'SKILL.md', contentBase64: 'LS0tCm5hbWU6IGd1aWRlCmRlc2NyaXB0aW9uOiBndWlkZQotLS0KSGVscC4=', contentKind: 'utf8' },
      { path: 'images/example.bin', contentBase64: 'AAH//g==', contentKind: 'binary' },
    ] }] };
    await f.run('template.draft', { sourceSessionRef, content: portable });
    await f.run('template.release', { draftArtifactId: draftId, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, version: '1.0.0', changelog: '' });
    const before = [...f.events];
    const source = { kind: 'artifact', serverId: 'home', artifactId: releaseId };
    expect(await f.run('template.export_file', { source, skillKey: 'guide', path: 'images/example.bin' }))
      .toMatchObject({ ok: true, result: { fileName: 'example.bin', contentBase64: 'AAH//g==', contentKind: 'binary' } });
    expect(await f.run('template.export_file', { source, skillKey: 'guide', path: '../private' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    expect(f.events).toEqual(before);
  });
  it('allows agent drafting by default and routes release and explicit draft Ask through ordinary approval', async () => {
    const executor = createActionExecutor({});
    const context = { surface: 'agent' as const, authority: 'account_automation' as const, serverId: 'home' };
    expect(await executor.prepare('template.draft', { sourceSessionRef, content }, context)).toMatchObject({ kind: 'ready' });
    const input = { draftArtifactId: draftId, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, version: '1.0.0', changelog: '',
      share: { recipients: [{ kind: 'account', accountId: 'recipient' }] } };
    expect(await executor.execute('template.release', input, context)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(await executor.execute('template.draft', { sourceSessionRef, content }, { ...context,
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: { 'template.draft': { approvalRequiredSurfaces: ['agent'] } } }) }))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
  });
  it('captures one release approval containing the reviewed revision and named grant operands', async () => {
    const requests: unknown[] = [];
    const executor = createActionExecutor({ approvalsCreate: async ({ request }) => {
      requests.push(request); return { artifactId: 'approval', request };
    } });
    const input = { draftArtifactId: draftId, expectedRevision: { headerVersion: 4, bodyVersion: 6 }, version: '1.2.3', changelog: 'Reviewed notes',
      share: { recipients: [{ kind: 'account', accountId: 'recipient' }] } };
    const result = await executor.execute('template.release', input, { surface: 'agent', authority: 'account_automation', serverId: 'home',
      actionCaller: { kind: 'host' }, actionRequestId: 'template-release-review', defaultSessionMachineId: 'machine',
      serverIdentityId: 'srv_home', runtimeAccountId: 'author', defaultSessionId: 'source-bot' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ actionId: 'template.release', actionArgs: input });
  });
  it('opens a released preview with one addressed read and no recipient writes', async () => {
    const f = fixture();
    await f.run('template.draft', { sourceSessionRef, content });
    await f.run('template.release', { draftArtifactId: draftId, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      version: '1.0.0', changelog: 'First release' });
    const before = [...f.events];
    const reads = f.boundary.reads.length;
    const source = { kind: 'artifact', serverId: 'home', artifactId: releaseId };
    expect(await f.run('template.preview', { source })).toMatchObject({ ok: true,
      result: { source, release: { version: '1.0.0', content }, revision: { headerVersion: 1, bodyVersion: 1 } } });
    expect(f.boundary.reads.slice(reads)).toEqual([releaseId]);
    expect(f.events).toEqual(before);
    expect(await f.run('template.preview', { source: { ...source, artifactId: draftId } }))
      .toMatchObject({ ok: false, errorCode: 'invalid_request' });
    expect(await f.run('template.preview', { source: { ...source, serverId: 'other-home' } }))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
  });
  it('writes the private source pointer before creating a draft and releases only portable content', async () => {
    const f = fixture();
    const drafted = await f.run('template.draft', { sourceSessionRef, content });
    expect(drafted).toMatchObject({ ok: true, result: { draftArtifactId: draftId, revision: { headerVersion: 1, bodyVersion: 1 } } });
    expect(f.events).toEqual([`ref:${draftId}`, `create:${draftId}`]);
    expect(f.boundary.reads).toEqual([]);
    const released = await f.run('template.release', { draftArtifactId: draftId, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      version: '1.0.0', changelog: 'First release', share: { recipients: [{ kind: 'account', accountId: 'recipient' }] } });
    expect(released).toMatchObject({ ok: true, result: { artifactId: releaseId, reused: false, release: { version: '1.0.0', content } } });
    expect(f.boundary.reads).toEqual([draftId, releaseId]);
    const row = f.boundary.rows.get(releaseId)!;
    expect(typeof row.body).toBe('string');
    expect(JSON.parse(String(row.body))).toEqual({ v: 1, state: 'released', release: { v: 1, version: '1.0.0', changelog: 'First release', releasedAtMs: 100, content } });
    expect(row).toHaveProperty('savedBy', null);
    expect(row.header).not.toHaveProperty('sourceSessionRef');
    expect(f.events.at(-1)).toBe(`grant:${releaseId}:view`);
  });

  it('refuses a grant-reachable incumbent returned by same-id draft creation', async () => {
    const f = fixture();
    const draft = { v: 1 as const, state: 'draft' as const, sourceSessionRef, releaseArtifactId: releaseId,
      content, candidates: { memoryRules: [], skills: [] } };
    f.boundary.rows.set(draftId, { artifactId: draftId, header: projectBotTemplateArtifactHeaderV1(draft),
      body: JSON.stringify(draft), revision: { headerVersion: 1, bodyVersion: 1 }, access: 'owner', shared: true });
    expect(await f.run('template.draft', { sourceSessionRef, content }))
      .toMatchObject({ ok: false, errorCode: 'artifact_access_forbidden' });
  });

  it('rejects stale reviewed revisions before writing or granting and reuses an unchanged release', async () => {
    const f = fixture();
    await f.run('template.draft', { sourceSessionRef, content });
    const input = { draftArtifactId: draftId, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, version: '1.0.0', changelog: '' };
    expect(await f.run('template.release', input)).toMatchObject({ ok: true });
    const writes = [...f.events];
    expect(await f.run('template.release', input)).toMatchObject({ ok: true, result: { reused: true, release: { version: '1.0.0' } } });
    expect(f.events).toEqual(writes);
    expect(await f.run('template.release', { ...input, expectedRevision: { headerVersion: 2, bodyVersion: 2 } }))
      .toMatchObject({ ok: false, errorCode: 'version_mismatch' });
    expect(f.events).toEqual(writes);
  });

  it('keeps reviewed version and notes aligned with publication when content is unchanged', async () => {
    const f = fixture();
    await f.run('template.draft', { sourceSessionRef, content });
    const input = { draftArtifactId: draftId, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      version: '1.0.0', changelog: 'First release' };
    await f.run('template.release', input);
    expect(await f.run('template.release', { ...input, changelog: 'Unreviewed replacement notes' }))
      .toMatchObject({ ok: false, errorCode: 'version_mismatch' });
    expect(await f.run('template.release', { ...input, version: '0.9.0' }))
      .toMatchObject({ ok: false, errorCode: 'version_mismatch' });
    const next = { ...input, version: '1.1.0', changelog: 'A deliberate new publication' };
    expect(await f.run('template.release', next)).toMatchObject({ ok: true, result: {
      reused: false, release: { version: next.version, changelog: next.changelog, content } } });
    const revision = f.boundary.rows.get(releaseId)!.revision;
    expect(await f.run('template.release', next)).toMatchObject({ ok: true, result: {
      reused: true, revision, release: { version: next.version, changelog: next.changelog } } });
    expect(f.boundary.rows.get(releaseId)!.revision).toEqual(revision);
  });

  it('preserves the reviewed publication timestamp in the released portable bytes', async () => {
    const f = fixture();
    await f.run('template.draft', { sourceSessionRef, content });
    const input = { draftArtifactId: draftId, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      version: '1.0.0', changelog: 'Reviewed publication', releasedAtMs: 54321 };
    expect(await f.run('template.release', input)).toMatchObject({ ok: true, result: {
      reused: false, release: { releasedAtMs: input.releasedAtMs, version: input.version, changelog: input.changelog, content } } });
    expect(JSON.parse(String(f.boundary.rows.get(releaseId)!.body)).release.releasedAtMs).toBe(input.releasedAtMs);
    expect(await f.run('template.release', { ...input, releasedAtMs: 54322 }))
      .toMatchObject({ ok: false, errorCode: 'version_mismatch' });
  });

  it('keeps content operations usable when a headless host has no presenter', async () => {
    const f = fixture();
    expect(await f.run('template.draft', { sourceSessionRef, content })).toMatchObject({ ok: true });
    expect(await f.run('template.open', { sourceSessionRef, draftArtifactId: draftId }))
      .toMatchObject({ ok: false, errorCode: 'surface_unavailable' });
  });

  it('preserves typed grant failures and retries the same release without another write', async () => {
    let refused = true;
    const f = fixture({ grant: async () => { if (refused) throw Object.assign(new Error('refused'), { code: 'artifact_e2ee_to_plain_forbidden' }); } });
    await f.run('template.draft', { sourceSessionRef, content });
    const input = { draftArtifactId: draftId, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, version: '1.0.0', changelog: '',
      share: { recipients: [{ kind: 'account', accountId: 'recipient' }] } };
    expect(await f.run('template.release', input)).toMatchObject({ ok: false, errorCode: 'artifact_e2ee_to_plain_forbidden' });
    refused = false;
    expect(await f.run('template.release', input)).toMatchObject({ ok: true, result: { artifactId: releaseId, reused: true } });
    expect(f.events.filter(event => event === `create:${releaseId}`)).toHaveLength(1);
  });

  it('keeps an existing release intact while privately editing and requires a newer SemVer for changed content', async () => {
    const f = fixture();
    await f.run('template.draft', { sourceSessionRef, content });
    const input = { draftArtifactId: draftId, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, version: '1.0.0', changelog: '' };
    await f.run('template.release', input);
    const releasedBody = f.boundary.rows.get(releaseId)!.body;
    const changed = { ...content, instructions: { markdown: 'New reusable instructions' } };
    await f.run('template.draft', { sourceSessionRef, draftArtifactId: draftId, expectedRevision: input.expectedRevision, content: changed });
    expect(f.boundary.rows.get(releaseId)!.body).toEqual(releasedBody);
    expect(await f.run('template.release', { ...input, expectedRevision: { headerVersion: 2, bodyVersion: 2 } }))
      .toMatchObject({ ok: false, errorCode: 'version_mismatch' });
    expect(await f.run('template.release', { ...input, expectedRevision: { headerVersion: 2, bodyVersion: 2 }, version: '1.0.1' }))
      .toMatchObject({ ok: true, result: { release: { version: '1.0.1', content: changed } } });
  });
});
