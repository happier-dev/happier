import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionExecutor, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER, ArtifactBlobWriteV1Schema, readLegacyRolesV1, type ArtifactPublicLinkIssuedV1 } from '@happier-dev/protocol';
import { buildHomeHubArtifactIdV1, HOME_HUB_ARTIFACT_KIND_V1, HomeHubLayoutV1Schema } from '@happier-dev/protocol/home';
import { buildWidgetDefinitionArtifactHeaderV1, type WidgetDefinitionV1 } from '@happier-dev/protocol/widgets';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import * as persistence from '@/persistence';
import { configuration } from '@/configuration';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { createCliActionDeps } from './createCliActionDeps';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1, loadPromptLibraryCatalogV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { clearActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ARTIFACT_HTML_BUNDLE_MIME_V1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('axios', () => ({ default: http }));

describe('Account Artifact Actions through the real CLI host composition', () => {
  let root: string;
  const artifactId = '11111111-1111-4111-8111-111111111111';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cli-artifact-actions-'));
    await mkdir(join(root, 'workspace'));
    http.get.mockReset(); http.post.mockReset(); http.delete.mockReset();
    // Machine identity is persistent machine-local configuration, a system boundary.
    await persistence.writeSettings({ schemaVersion: persistence.SUPPORTED_SCHEMA_VERSION,
      onboardingCompleted: true, machineIdByServerId: { [configuration.activeServerId]: 'local-machine' } });
  });
  afterEach(async () => { clearActiveAccountSettingsSnapshot(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  function deps(onPublicLinkIssued?: (link: ArtifactPublicLinkIssuedV1) => void) {
    return createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      onPublicLinkIssued,
      sessionId: 'session', mode: 'plain', ctx: null,
      rawSession: { machineId: 'local-machine', path: join(root, 'workspace'),
        metadata: JSON.stringify({ machineId: 'local-machine', path: join(root, 'workspace') }) } });
  }
  function workspaceArtifactExecutor(host: ReturnType<typeof createCliActionDeps>) {
    // These source-custody fixtures model Account-waived Agent operations, not
    // a CLI confirmation that could override authenticated Session identity.
    const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
      'artifact.create': ['agent'], 'artifact.update': ['agent'], 'artifact.publish_from_file': ['agent'],
    } });
    return createActionExecutor({ ...host,
      isActionApprovalRequired: (actionId, context, input) =>
        isApprovalRequiredByActionsSettings(actionId, settings, context, undefined, undefined, input),
    });
  }
  it('creates the same host-derived editable guide starter through CLI Action admission without caller provenance', async () => {
    const accountId = 'cli-guide-starter';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const rows: Record<string, unknown>[] = [];
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      throw new Error(`unexpected_get:${url}`);
    });
    http.post.mockImplementation(async (_url: string, wire: unknown) => {
      const input = readCarrierMutation(wire);
      const row = { ...input, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      rows.push(row);
      return { status: 200, data: row };
    });
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'cli-guide-home', serverHttpBaseUrl: 'https://cli-guide.test' }));
    const context = { surface: 'cli', authority: 'present_user', bypassApprovals: true,
      presentUserConfirmation: { actionId: 'prompt_doc.create' } } as const;
    expect(await executor.execute('prompt_doc.create', { starter: 'happier_guide' }, context))
      .toMatchObject({ ok: true, result: { ok: true, artifactId: expect.any(String) } });
    expect(rows).toHaveLength(1);
    expect(decodePlainArtifactStoredContent(String(rows[0]!.header))).toMatchObject({ kind: 'prompt_doc.v2', origin: 'built_in', locked: false });
    expect(await executor.execute('prompt_doc.create', { title: 'Forged', markdown: 'Caller content', origin: 'built_in' }, context))
      .toMatchObject({ ok: false });
    expect(rows).toHaveLength(1);
  });
  it('refuses generic deletion of a retained Role when current guidance is malformed, without blocking unrelated documents', async () => {
    const accountId = 'retained-guidance-deletion-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const [retainedRole] = readLegacyRolesV1({ executionRunsGuidanceEntries: [
      { id: 'retained-role', description: 'Retained guidance' },
    ] }, accountId);
    if (!retainedRole) throw new Error('Expected retained Role identity');
    const unrelatedRoleId = '22222222-2222-4222-8222-222222222222';
    const unclassifiedId = '33333333-3333-4333-8333-333333333333';
    const corruptedDocumentId = '44444444-4444-4444-8444-444444444444';
    let rawSettings: Readonly<Record<string, unknown>> = {
      executionRunsGuidanceEntries: [{ id: 'retained-role', description: null }],
    };
    let retainedKind = 'role.v1';
    const wireRow = (id: string) => ({ id, header: encodePlainArtifactStoredContent({
      ...(id === unclassifiedId ? {} : { kind: id === retainedRole.artifactId ? retainedKind : id === artifactId || id === corruptedDocumentId ? 'document.v1' : 'role.v1' }), title: 'Retained content',
    }), body: encodePlainArtifactStoredContent(id === corruptedDocumentId ? { corruptBody: true } : { body: 'Retained content' }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1,
        content: { t: 'plain', v: rawSettings } } };
      const id = new URL(url).pathname.split('/').at(-1);
      if (id === retainedRole.artifactId || id === unrelatedRoleId || id === artifactId || id === unclassifiedId || id === corruptedDocumentId) return { status: 200, data: wireRow(id) };
      throw new Error(`unexpected_get:${url}`);
    });
    http.delete.mockResolvedValue({ status: 200, data: { success: true } });
    // CLI composition starts inside the authenticated Account lifetime. Load
    // actual catalog records through its owner rather than mocking admission.
    const promptLibraryCatalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null,
      readRows: async () => ({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
        key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) },
      })) }),
    });
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(rawSettings), rawSettings,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], promptLibraryCatalog,
      scopeKey: runWithServerHttpBaseUrl('https://retained-guidance-deletion.test', () => resolveAccountSettingsScopeKeyForToken(token)) });
    const hostDeps = createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'retained-guidance-deletion',
      serverHttpBaseUrl: 'https://retained-guidance-deletion.test' });
    const executor = createActionExecutor(hostDeps);
    const context = { surface: 'cli', authority: 'present_user', bypassApprovals: true,
      presentUserConfirmation: { actionId: 'artifact.delete' } } as const;
    expect(await executor.execute('artifact.delete', { artifactId: retainedRole.artifactId,
      expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: false, errorCode: 'role_source_incomplete' });
    expect(http.delete).not.toHaveBeenCalled();
    expect(await executor.execute('artifact.delete', { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: true, result: { artifactId, deleted: true } });
    expect(await executor.execute('artifact.delete', { artifactId: unrelatedRoleId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: true, result: { artifactId: unrelatedRoleId, deleted: true } });
    // The public frontdoor already opens content for actual-kind admission.
    // Exercise the real host adapter separately so this guard adds no body read.
    if (!hostDeps.artifactAction) throw new Error('Expected Artifact host adapter');
    const corruptDeletion = await hostDeps.artifactAction({ actionId: 'artifact.delete',
      input: { artifactId: corruptedDocumentId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context });
    expect(corruptDeletion, JSON.stringify(corruptDeletion)).toMatchObject({ artifactId: corruptedDocumentId, deleted: true });
    rawSettings = { executionRunsGuidanceEntries: [{ id: 'retained-role', description: null }, { description: 'Missing identity' }] };
    retainedKind = 'document.v1';
    http.delete.mockClear();
    expect(await executor.execute('artifact.delete', { artifactId: retainedRole.artifactId,
      expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: false, errorCode: 'role_source_incomplete' });
    expect(http.delete).not.toHaveBeenCalled();
    rawSettings = { executionRunsGuidanceEntries: null };
    http.delete.mockClear();
    expect(await executor.execute('artifact.delete', { artifactId: unrelatedRoleId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: false, errorCode: 'role_source_incomplete' });
    expect(http.delete).not.toHaveBeenCalled();
    expect(await executor.execute('artifact.delete', { artifactId: unclassifiedId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: false, errorCode: 'role_source_incomplete' });
    expect(http.delete).not.toHaveBeenCalled();
    expect(await executor.execute('artifact.delete', { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: true, result: { artifactId, deleted: true } });
  });
  it('projects authored Home size from current scoped definition headers without rewriting stale saved intent', async () => {
    const accountId = 'authored-home-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const homeArtifactId = buildHomeHubArtifactIdV1(accountId);
    const definition: WidgetDefinitionV1 = { v: 1, id: artifactId, name: 'Authored',
      sizeDeclaration: { sizes: ['wide'], defaultSize: 'wide' },
      body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Hello' } } },
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
      provenance: { source: { kind: 'authored' } } };
    const instance = { v: 1 as const, id: 'authored-copy', definition: { kind: 'artifact' as const, artifactId }, bindings: {} };
    const layout = HomeHubLayoutV1Schema.parse({ v: 1, order: [instance.id], hidden: [],
      items: [{ kind: 'widget', instance, size: 'medium', frameStyle: 'plain' }] });
    const wireRow = (id: string, header: Readonly<Record<string, unknown>>, body?: string) => ({ id,
      header: encodePlainArtifactStoredContent(header), ...(body ? { body: encodePlainArtifactStoredContent({ body }) } : {}),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (new URL(url).pathname === '/v1/artifacts') return { status: 200,
        data: [wireRow(artifactId, buildWidgetDefinitionArtifactHeaderV1(definition))] };
      if (url.endsWith(`/v1/artifacts/${homeArtifactId}`)) return { status: 200,
        data: wireRow(homeArtifactId, { kind: HOME_HUB_ARTIFACT_KIND_V1, v: 1 }, JSON.stringify(layout)) };
      throw new Error(`unexpected_get:${url}`);
    });
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'authored-home', serverHttpBaseUrl: 'https://authored-home.test' }));
    expect(await executor.execute('home.hub.layout.get', {}, { surface: 'cli', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { layout, sections: expect.arrayContaining([
        expect.objectContaining({ id: instance.id, size: 'wide', frameStyle: 'plain' }),
      ]) } });
    expect(http.post).not.toHaveBeenCalled();
  });
  it.each(['widget-area-layout.v1', 'home-hub-layout.v1'])('refuses approved agent public publication of %s before transport', async kind => {
    http.get.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/v1/account/encryption')
      ? { mode: 'plain', updatedAt: 1 } : { id: artifactId, header: encodePlainArtifactStoredContent({ kind }),
        body: encodePlainArtifactStoredContent({ body: '{}' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } }));
    const publicShare = { id: 'share-1', subject: { kind: 'artifact', id: artifactId }, expiresAt: null, maxUses: null,
      useCount: 0, isConsentRequired: false, createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1' };
    http.post.mockResolvedValue({ status: 200, data: { publicShare, isolatedOrigin: 'https://public.example.test' } });
    const executor = createActionExecutor(deps());
    expect(await executor.execute('artifact.public_link.create', { artifactId }, { surface: 'cli',
      // The host resumes an approved invocation with this canonical execution context.
      bypassApprovals: true, authority: 'present_user',
      actionCaller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 }, defaultSessionId: 'session',
      presentUserConfirmation: { actionId: 'artifact.public_link.create' } })).toMatchObject({ ok: false, errorCode: 'artifact_kind_not_shareable' });
    expect(http.post).not.toHaveBeenCalled();
  });
  it('keeps native widgets available without a daemon and edits independent Home copies through the Account Artifact owner', async () => {
    const accountId = 'native-widget-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const homeArtifactId = buildHomeHubArtifactIdV1(accountId);
    const serverId = configuration.activeServerId;
    const copy = (id: string, sessionId: string) => ({ v: 1 as const, id,
      definition: { kind: 'builtin' as const, id: 'session_summary' },
      bindings: { session: { kind: 'value' as const, value: { serverId, sessionId } } } });
    let layout = HomeHubLayoutV1Schema.parse({ v: 1, order: ['one', 'two'], hidden: [],
      items: [{ kind: 'widget', instance: copy('one', 'A') }, { kind: 'widget', instance: copy('two', 'B'), frameStyle: 'plain', size: 'full' }] });
    let version = 1;
    const selectedSessionId = 'c000000000000000000000003';
    const selectedSession = V2SessionByIdResponseSchema.parse({ session: { id: selectedSessionId, seq: 1, createdAt: 1, updatedAt: 1,
      active: false, activeAt: 1, encryptionMode: 'plain', dataEncryptionKey: null,
      metadata: JSON.stringify({ host: 'offline-session-host', path: join(root, 'workspace') }), metadataVersion: 1,
      agentState: null, agentStateVersion: 1,
    } });
    const row = () => ({ id: homeArtifactId,
      header: encodePlainArtifactStoredContent({ kind: HOME_HUB_ARTIFACT_KIND_V1, v: 1, title: 'Home layout' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(layout) }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
      headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version });
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: AccountEncryptionCurrentnessResponseSchema.parse({
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      }) };
      if (new URL(url).pathname === `/v2/sessions/${selectedSessionId}`) return { status: 200,
        data: selectedSession };
      if (new URL(url).pathname === '/v2/sessions' || new URL(url).pathname === '/v2/sessions/active') return { status: 200,
        data: { sessions: [selectedSession.session], nextCursor: null, hasNext: false } };
      if (url.endsWith(`/v1/artifacts/${homeArtifactId}`)) return { status: 200, data: row() };
      throw new Error(`unexpected_get:${url}`);
    });
    http.post.mockImplementation(async (url: string, wire: Record<string, unknown> | Buffer) => {
      if (new URL(url).pathname === '/v2/sessions/query') return { status: 200, data: SessionListQueryResponseV1Schema.parse({
        sessions: [{ ...selectedSession.session, responsibleAccountId: null, responsibleAccount: null,
          effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
          viewer: { readState: { state: 'not_started' }, relevance: { relevant: false, reasons: [] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            follow: { follows: false, notificationLevel: 'none' }, notification: { level: 'none', source: 'preference' } },
        }], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }) };
      expect(url).toBe(`https://native-home.test/v1/artifacts/${homeArtifactId}`);
      const input = readCarrierMutation(wire);
      expect(input.expectedBodyVersion).toBe(version);
      const content = decodePlainArtifactStoredContent(input.body as string);
      if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') throw new Error('invalid Artifact body');
      layout = HomeHubLayoutV1Schema.parse(JSON.parse(content.body));
      version += 1;
      return { status: 200, data: { success: true, headerVersion: version, bodyVersion: version } };
    });
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: selectedSessionId, mode: 'plain', ctx: null, serverId, serverHttpBaseUrl: 'https://native-home.test' }));
    const context = { surface: 'cli', serverId, bypassApprovals: true } as const;
    const described = await executor.execute('home.hub.layout.get', {}, context);
    expect(described, JSON.stringify(described)).toMatchObject({ ok: true, result: {
      availableWidgetIds: ['builtin:session_summary', 'builtin:agent_plan', 'builtin:changes', 'builtin:local_services',
        'builtin:project_about', 'builtin:project_code', 'builtin:project_readme', 'builtin:project_checkouts',
        'builtin:project_scripts', 'builtin:project_sessions', 'builtin:project_changes'],
      layout: { items: [{ instance: copy('one', 'A') }, { instance: copy('two', 'B') }] },
    } });
    expect(http.post).not.toHaveBeenCalled();
    const edited = await executor.execute('home.hub.layout.update', { intent: { kind: 'widget_inputs', instanceId: 'one',
      bindings: copy('one', selectedSessionId).bindings } }, context);
    expect(edited, JSON.stringify(edited)).toMatchObject({ ok: true });
    expect(layout.items).toMatchObject([{ instance: copy('one', selectedSessionId) }, { instance: copy('two', 'B'), frameStyle: 'plain', size: 'full' }]);
    expect(layout.items).toHaveLength(2);
  });
  it('creates, updates, reads and publishes private HTML through approved Artifact Actions without byte-bearing URLs', async () => {
    await writeFile(join(root, 'workspace', 'document.html'), '<h1>Published HTML</h1>');
    let row: Record<string, unknown> = {};
    let version = 0;
    http.get.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/v1/account/encryption')
      ? { mode: 'plain', updatedAt: 1 } : url.endsWith('/html-preview')
      ? { url: `https://isolated.example/a/${row.id}` } : url.includes('/blobs/')
      ? ArtifactBlobWriteV1Schema.parse(row.blob) : row }));
    http.post.mockImplementation(async (_url: string, wire: Record<string, unknown> | Buffer) => {
      const input = readCarrierMutation(wire);
      version += 1;
      row = { ...row, ...input, id: input.id ?? row.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version };
      return { status: 200, data: { ...row, success: true } };
    });
    const executor = workspaceArtifactExecutor(deps());
    const context = { surface: 'cli' as const,
      actionCaller: { kind: 'session' as const, sessionId: 'session', starterDepth: 0, turnDepth: 0 }, defaultSessionId: 'session' };
    await expect(executor.execute('artifact.create', { artifactId, header: { kind: 'html' }, body: '<h1>Private HTML</h1>' },
      { ...context, presentUserConfirmation: { actionId: 'artifact.create' } })).resolves.toEqual({ ok: true, result: { artifactId, revision: { headerVersion: 1, bodyVersion: 1 } } });
    await expect(executor.execute('artifact.update', { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      header: { kind: 'html' }, uploadPath: 'document.html' }, { ...context, presentUserConfirmation: { actionId: 'artifact.update' } }))
      .resolves.toEqual({ ok: true, result: { artifactId, revision: { headerVersion: 2, bodyVersion: 2 } } });
    const read = await executor.execute('artifact.get', { artifactId }, context);
    expect(read).toMatchObject({ ok: true, result: { artifact: { header: { kind: 'html' },
      body: { mime: 'text/html', sizeBytes: Buffer.byteLength('<h1>Published HTML</h1>') } } } });
    expect(read).not.toHaveProperty('result.previewUrl');
    expect(read).not.toHaveProperty('result.previewError');
    const published = await executor.execute('artifact.publish_from_file', { path: 'document.html' },
      { ...context, presentUserConfirmation: { actionId: 'artifact.publish_from_file' } });
    expect(published).toEqual({ ok: true, result: { artifactId: row.id, revision: { headerVersion: 3, bodyVersion: 3 } } });
    expect(decodePlainArtifactStoredContent(row.header as string)).toMatchObject({ kind: 'html', mime: 'text/html' });
    expect(http.post.mock.calls.some(([url]) => String(url).includes('/public-shares'))).toBe(false);
    expect(http.get.mock.calls.some(([url]) => String(url).endsWith('/html-preview'))).toBe(false);
  });
  it('publishes a declared folder entrypoint through the approved Artifact Action as the exact acquired bundle', async () => {
    await mkdir(join(root, 'workspace', 'site', 'pages'), { recursive: true });
    await mkdir(join(root, 'workspace', 'site', 'assets'));
    const assets = {
      'pages/index.html': { mime: 'text/html', bytes: Buffer.from('<script type="module" src="../assets/main.js"></script>') },
      'assets/main.js': { mime: 'text/javascript', bytes: Buffer.from('import "./dep.mjs"; fetch("../data.json")') },
      'assets/dep.mjs': { mime: 'text/javascript', bytes: Buffer.from('document.body.dataset.loaded="yes"') },
      'assets/style.css': { mime: 'text/css', bytes: Buffer.from('@font-face {src:url("./font.woff2")}') },
      'assets/icon.png': { mime: 'image/png', bytes: Buffer.from([137, 80, 78, 71, 0, 255]) },
      'assets/font.woff2': { mime: 'font/woff2', bytes: Buffer.from([119, 79, 70, 50, 0, 255]) },
      'data.json': { mime: 'application/json', bytes: Buffer.from('{"value":42}') },
    };
    for (const [path, asset] of Object.entries(assets)) await writeFile(join(root, 'workspace', 'site', path), asset.bytes);
    const bundle = { v: 1, entrypoint: 'pages/index.html', files: Object.fromEntries(Object.entries(assets)
      .map(([path, asset]) => [path, { mime: asset.mime, contentBase64: asset.bytes.toString('base64') }])) };
    let publication: Record<string, unknown> = {};
    http.get.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/v1/account/encryption')
      ? { mode: 'plain', updatedAt: 1 } : { url: 'https://isolated.example/a/published' } }));
    http.post.mockImplementation(async (_url: string, wire: unknown) => {
      publication = readCarrierMutation(wire);
      return { status: 200, data: { id: publication.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const executor = workspaceArtifactExecutor(deps());
    const context = { surface: 'cli', actionCaller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 },
      defaultSessionId: 'session', presentUserConfirmation: { actionId: 'artifact.publish_from_file' } } as const;
    const result = await executor.execute('artifact.publish_from_file', { path: 'site', entrypoint: 'pages/index.html', title: 'Experiment' }, context);
    expect(result).toEqual({ ok: true, result: { artifactId: publication.id, revision: { headerVersion: 1, bodyVersion: 1 } } });
    expect(decodePlainArtifactStoredContent(String(publication.header))).toMatchObject({ title: 'Experiment', kind: 'html', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 });
    const blob = ArtifactBlobWriteV1Schema.parse(publication.blob);
    expect(blob.content.t === 'plain' && JSON.parse(Buffer.from(blob.content.v, 'base64').toString('utf8'))).toEqual(bundle);
    expect(decodePlainArtifactStoredContent(String(publication.provenance))).toMatchObject({ provenance: { source: {
      sessionId: 'session', machineId: 'local-machine', path: 'site',
    } } });
    http.post.mockClear();
    await expect(executor.execute('artifact.publish_from_file', { path: 'site', entrypoint: '../index.html' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    await expect(executor.execute('artifact.publish_from_file', { path: 'site' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'artifact_source_forbidden' });
    expect(http.post).not.toHaveBeenCalled();
  });
  it('lists, revokes and creates owner public links without a mounted delivery consumer', async () => {
    const publicShare = { id: 'share-1', subject: { kind: 'artifact', id: artifactId }, expiresAt: null, maxUses: null,
      useCount: 0, isConsentRequired: false, createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1' };
    http.get.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
      : url.includes('/v1/public-shares') ? { publicShares: [publicShare] }
      : { id: artifactId, header: encodePlainArtifactStoredContent({ title: 'Note' }),
        body: encodePlainArtifactStoredContent({ body: 'note' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } }));
    http.delete.mockResolvedValue({ status: 200, data: { success: true } });
    http.post.mockResolvedValue({ status: 200, data: { publicShare, isolatedOrigin: 'https://public.example.test' } });
    const executor = createActionExecutor(deps());
    const context = { surface: 'cli' as const, authority: 'present_user' as const,
      presentUserConfirmation: { actionId: 'artifact.public_link.list' as const } };
    await expect(executor.execute('artifact.public_link.list', { artifactId }, context)).resolves.toEqual({ ok: true, result: { publicShares: [publicShare] } });
    await expect(executor.execute('artifact.public_link.revoke', { artifactId, shareId: 'share-1' },
      { ...context, presentUserConfirmation: { actionId: 'artifact.public_link.revoke' } })).resolves.toMatchObject({ ok: true, result: { revoked: true } });
    await expect(executor.execute('artifact.public_link.create', { artifactId },
      { ...context, presentUserConfirmation: { actionId: 'artifact.public_link.create' } })).resolves.toMatchObject({ ok: true, result: { publicShare, url: expect.stringMatching(/^https:\/\/public.example.test\/s\/[^#]+#k=.+$/) } });
  });
  it('returns an approved Artifact fragment link and also notifies an optional mounted host', async () => {
    const issued: ArtifactPublicLinkIssuedV1[] = [];
    const publicShare = { id: 'share-1', subject: { kind: 'artifact', id: artifactId }, expiresAt: null, maxUses: null,
      useCount: 0, isConsentRequired: false, createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1' };
    http.get.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
      : { id: artifactId, header: encodePlainArtifactStoredContent({ title: 'Note' }),
      body: encodePlainArtifactStoredContent({ body: 'note' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } }));
    http.post.mockResolvedValue({ status: 200, data: { publicShare, isolatedOrigin: 'https://public.example.test' } });
    const executor = createActionExecutor({ ...deps(link => { issued.push(link); }), isActionApprovalRequired: () => false });
    const result = await executor.execute('artifact.public_link.create', { artifactId },
      { surface: 'cli', presentUserConfirmation: { actionId: 'artifact.public_link.create' } });
    expect(result).toEqual({ ok: true, result: { publicShare, url: issued[0]?.url } });
    expect(issued).toHaveLength(1);
    expect(issued[0]?.url).toBe(`https://public.example.test/s/${issued[0]?.lookupId}#k=${issued[0]?.secret}`);
    expect(JSON.stringify(http.post.mock.calls[0]?.[1])).not.toContain(issued[0]?.secret);
    expect(http.post.mock.calls[0]?.[1]).not.toHaveProperty('encryptedDataKey');
  });
  it('creates and reads Account content through the Action executor and existing mode-aware store', async () => {
    let row: unknown;
    http.get.mockImplementation(async (url: string) => ({ status: 200,
      data: url.endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
        : new URL(url).pathname === '/v1/artifacts' ? [row] : row }));
    http.post.mockImplementation(async (_url: string, value: Record<string, unknown>) => {
      row = { ...value, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      return { status: 200, data: { id: value.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const executor = createActionExecutor({ ...deps(), isActionApprovalRequired: () => false });
    await expect(executor.execute('artifact.create', { artifactId, header: { title: 'Note', kind: 'published.v1' }, body: 'note' },
      { surface: 'cli', presentUserConfirmation: { actionId: 'artifact.create' } })).resolves.toMatchObject({ ok: true,
        result: { artifactId, revision: { headerVersion: 1, bodyVersion: 1 } } });
    await expect(executor.execute('artifact.get', { artifactId }, { surface: 'cli' })).resolves.toMatchObject({ ok: true,
      result: { artifact: { artifactId, header: { title: 'Note' }, body: 'note', access: 'owner' } } });
    await expect(executor.execute('artifact.list', { search: 'Note', kind: 'published.v1', sort: 'title_asc' }, { surface: 'cli' }))
      .resolves.toMatchObject({ ok: true, result: { items: [{ artifactId, header: { title: 'Note' } }] } });
  });

  it('preserves quota details through the public Action failure envelope', async () => {
    http.get.mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    http.post.mockResolvedValue({ status: 413, data: { error: 'quota_exceeded', budget: 'account', limitBytes: 10, usedBytes: 20 } });
    const executor = createActionExecutor({ ...deps(), isActionApprovalRequired: () => false });
    await expect(executor.execute('artifact.create', { artifactId, header: {}, body: 'note' },
      { surface: 'cli', presentUserConfirmation: { actionId: 'artifact.create' } })).resolves.toMatchObject({
        ok: false, errorCode: 'quota_exceeded', details: { budget: 'account', limitBytes: 10, usedBytes: 20 },
      });
  });

  it('exports authenticated binary bytes to the caller workspace without overwriting or escaping it', async () => {
    const bytes = Buffer.from([0xff, 0, 42]);
    const body = { blobId: '22222222-2222-4222-8222-222222222222', mime: 'application/pdf', sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
    http.get.mockImplementation(async (url: string) => ({ status: 200,
      data: url.endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
        : url.includes('/blobs/') ? { blobId: body.blobId, content: { t: 'plain', v: bytes.toString('base64') } }
        : { id: artifactId, header: encodePlainArtifactStoredContent({ kind: 'file', title: 'Binary' }),
          body: encodePlainArtifactStoredContent({ body }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
          ownerAccountId: 'owner', access: 'view', encryptionMode: 'plain',
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } }));
    const executor = createActionExecutor({ ...deps(), isActionApprovalRequired: () => false });
    const context = { surface: 'cli' as const, actionCaller: { kind: 'session' as const, sessionId: 'session', starterDepth: 0, turnDepth: 0 },
      defaultSessionId: 'session', presentUserConfirmation: { actionId: 'artifact.export' as const } };
    const result = await executor.execute('artifact.export', { artifactId, path: 'downloads/binary.pdf' }, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { artifactId, path: 'downloads/binary.pdf', sizeBytes: bytes.length } });
    expect(await readFile(join(root, 'workspace/downloads/binary.pdf'))).toEqual(bytes);
    await writeFile(join(root, 'workspace/downloads/binary.pdf'), 'keep');
    expect(await executor.execute('artifact.export', { artifactId, path: 'downloads/binary.pdf' }, context)).toMatchObject({ ok: false });
    expect(await readFile(join(root, 'workspace/downloads/binary.pdf'), 'utf8')).toBe('keep');
    expect(await executor.execute('artifact.export', { artifactId, path: '../private.pdf' }, context))
      .toMatchObject({ ok: false, errorCode: 'artifact_destination_forbidden' });
    await symlink(root, join(root, 'workspace/escape'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await executor.execute('artifact.export', { artifactId, path: 'escape/private.pdf' }, context))
      .toMatchObject({ ok: false, errorCode: 'artifact_destination_forbidden' });
    const wrongHost = await executor.execute('artifact.export', { artifactId, path: 'foreign.pdf' }, { ...context, defaultSessionId: 'foreign' });
    expect(wrongHost).toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
  });

  it('creates and updates binary content only from the host-proved caller workspace', async () => {
    const bytes = Buffer.from([0xff, 0, 42]);
    await writeFile(join(root, 'workspace', 'image.png'), bytes);
    let row: Record<string, unknown> = {};
    http.get.mockImplementation(async (url: string) => ({ status: 200,
      data: url.endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 } : row }));
    http.post.mockImplementation(async (_url: string, wire: Record<string, unknown> | Buffer) => {
      const input = readCarrierMutation(wire);
      row = { ...row, ...input, id: artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      return { status: 200, data: { ...row, success: true } };
    });
    const executor = workspaceArtifactExecutor(deps());
    const caller = { surface: 'cli' as const,
      actionCaller: { kind: 'session' as const, sessionId: 'session', starterDepth: 0, turnDepth: 0 }, defaultSessionId: 'session' };
    await expect(executor.execute('artifact.create', { artifactId, header: {}, uploadPath: 'image.png', mime: 'image/png' },
      { ...caller, presentUserConfirmation: { actionId: 'artifact.create' } })).resolves.toMatchObject({ ok: true });
    expect(row.blob).toMatchObject({ content: { t: 'plain', v: bytes.toString('base64') } });
    await expect(executor.execute('artifact.update', { artifactId, header: {}, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      uploadPath: 'image.png', mime: 'image/png' }, { ...caller, presentUserConfirmation: { actionId: 'artifact.update' } }))
      .resolves.toMatchObject({ ok: true });
    http.post.mockClear();
    await expect(executor.execute('artifact.create', { header: {}, uploadPath: '../private.png' },
      { ...caller, presentUserConfirmation: { actionId: 'artifact.create' } })).resolves.toMatchObject({ ok: false, errorCode: 'artifact_source_forbidden' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('publishes only the authenticated caller workspace and refuses retargeting identity or another machine', async () => {
    await writeFile(join(root, 'workspace', 'result.txt'), 'result');
    http.get.mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    http.post.mockImplementation(async (_url: string, value: { id: string }) => ({ status: 200,
      data: { id: value.id, headerVersion: 1, bodyVersion: 1 } }));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const host = createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'session', mode: 'plain', ctx: null,
      rawSession: { machineId: 'local-machine', path: join(root, 'workspace'),
        metadata: JSON.stringify({ machineId: 'local-machine', path: join(root, 'workspace') }) } });
    const executor = workspaceArtifactExecutor(host);
    const context = { surface: 'cli' as const,
      actionCaller: { kind: 'session' as const, sessionId: 'session', starterDepth: 0, turnDepth: 0 },
      defaultSessionId: 'session', runtimeRunId: 'run', presentUserConfirmation: { actionId: 'artifact.publish_from_file' as const } };
    await expect(executor.execute('artifact.publish_from_file', { path: 'result.txt' }, context)).resolves.toMatchObject({ ok: true });
    const written = readCarrierMutation(http.post.mock.calls[0]?.[1]);
    expect(decodePlainArtifactStoredContent(String(written.header))).not.toHaveProperty('source');
    expect(decodePlainArtifactStoredContent(String(written.body))).toEqual({ body: 'result' });
    expect(decodePlainArtifactStoredContent(String(written.provenance))).toMatchObject({ provenance: {
      savedBy: { kind: 'agent', accountId: 'owner', sessionId: 'session' },
      source: { sessionId: 'session', runId: 'run', machineId: 'local-machine', path: 'result.txt' },
    } });
    http.post.mockClear();
    await expect(executor.execute('artifact.publish_from_file', { path: 'result.txt', sessionId: 'foreign' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    await expect(host.artifactAction?.({ actionId: 'artifact.publish_from_file', input: { path: 'result.txt' },
      context: { ...context, defaultSessionId: 'foreign' } })).resolves.toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
    const foreign = createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'session', mode: 'plain', ctx: null,
      rawSession: { machineId: 'remote-machine', path: join(root, 'workspace') } });
    await expect(foreign.artifactAction?.({ actionId: 'artifact.publish_from_file', input: { path: 'result.txt' }, context }))
      .resolves.toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
    expect(http.post).not.toHaveBeenCalled();
  });
});
