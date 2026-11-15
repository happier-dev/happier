import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createCliActionDeps } from './createCliActionDeps';
import { readReadOnlySkillContentV1 } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createServer } from 'node:http';
import { writeDaemonState } from '@/persistence';
import { RecordSkillUseInputSchema, RecordSkillUseResultSchema } from '@/prompts/skills/store/controlRoutes';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod/mini';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { prepareHappierMcpToolInventory, registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { SkillReadInputV1Schema, SkillReadResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { encodeSkillRevisionV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { bindContextualActionToolInput } from '@/agent/tools/happierTools/actionToolContext';
import nacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { resolveHappierSkillIdentity } from '@/prompts/skills/runtime/resolveHappierSkillIdentity';
import { readSkillInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';

const boundary = await vi.hoisted(async () => {
  const { createTempDir } = await import('@/testkit/fs/tempDir');
  const taskHome = await createTempDir('happier-skills-read-');
  vi.stubEnv('HAPPIER_HOME_DIR', taskHome);
  return { taskHome, get: vi.fn(), post: vi.fn() };
});
vi.mock('axios', () => ({ default: { defaults: {}, get: boundary.get, post: boundary.post } }));

describe('CLI skills.read real dependencies', () => {
  it('reads the listed qualified native identity through the advertised input contract', async () => {
    const content = readReadOnlySkillContentV1('happier:happier')!;
    const items = [{ skillId: 'happier:happier', name: 'happier', digest: content.digest }];
    const inventory = prepareHappierMcpToolInventory({ sessionId: 'active-session', inventory:
      createHappierToolInventory({ surface: 'agent', isActionEnabled: () => true, actionsSettings: null }) });
    const tool = inventory.registrations.find(entry => entry.tool.name === 'skills_read');
    if (!tool) throw new Error('skills_read was not advertised');
    const executor = createActionExecutor({ skillsRead: request => readSkillInLibrary({ request, sessionItems: items,
      store: { read: async () => { throw new Error('Bundled skill must not fetch an Artifact'); } } }) });
    for (const identity of [{ name: 'happier:happier' }, { skillId: 'happier:happier' }, { name: 'happier' }]) {
      expect(tool.meta.inputSchema.safeParse(identity).success).toBe(true);
      const request = bindContextualActionToolInput({ actionId: 'skills.read', input: identity,
        context: { defaultSessionId: 'active-session' } });
      expect(SkillReadInputV1Schema.safeParse(request).success).toBe(true);
      expect(resolveHappierSkillIdentity({ name: Object.values(identity)[0] }, { items })).toBe('happier:happier');
      expect(await executor.execute('skills.read', request, { surface: 'mcp' }))
        .toMatchObject({ ok: true, result: { skillId: 'happier:happier', skillMd: content.skillMd } });
    }
    expect(SkillReadInputV1Schema.safeParse({ skillId: 'happier', name: 'happier', sessionId: 'active-session',
      file: 'SKILL.md', includeFileContents: true }).success).toBe(false);
    expect(SkillReadInputV1Schema.safeParse({ skillId: 'happier:happier', unexpected: true }).success).toBe(false);
  });
  beforeEach(() => { resetActiveAccountSettingsSnapshotForTests(); boundary.get.mockReset(); boundary.post.mockReset(); });
  afterAll(async () => { const { createSkillStore } = await import('@/prompts/skills/store/skillStore');
    const store = createSkillStore({ happyHomeDir: boundary.taskHome });
    await store.releaseSkillSessionDirs('active-session');
    await store.collectSkillCache({ libraryDigests: [] });
    const { removeTempDir } = await import('@/testkit/fs/tempDir');
    await removeTempDir(boundary.taskHome); vi.unstubAllEnvs(); });
  it('reads a remote Session skill through its admitted signed target', async () => {
    const sessionId = 'c' + '2'.repeat(24);
    const sourceSessionId = 'c' + '1'.repeat(24);
    const actionId = 'skills.read' as const;
    const target = { kind: 'session' as const, sessionId };
    const request = { sessionId, name: 'review' };
    const envelope = { v: 1 as const, requestId: 'remote-skill-read', target, input: request };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-skill-proof', binding: {
      accountId: 'requester', custodianAccountId: 'custodian', authentication: { kind: 'account', tokenEpoch: 0 },
      serverIdentityId: 'home', machineId: 'reader-machine', installationId: 'installation',
      actionId, requestId: envelope.requestId, target, accountEncryptionMode: 'plain',
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
      externalActionTarget: target, externalActionExecutionAuthorization: authorization,
      expectedSessionAddress: { serverId: 'home', sessionId }, actionRequestId: envelope.requestId,
      actionCaller: { kind: 'session', sessionId: sourceSessionId, starterDepth: 0, turnDepth: 1 },
      sessionInputSource: { sourceSessionId, sourceTurnId: 'source-turn', via: 'action' } };
    const result = SkillReadResultV1Schema.parse({ skillId: 'review', name: 'review', skillMd: 'Review this change',
      revision: encodeSkillRevisionV1({ headerVersion: 1, bodyVersion: 1 }), provenance: { kind: 'written' }, modified: false,
      trust: 'text_only', cost: { descriptionTokens: 0, bodyTokens: 4 }, rules: [], files: [] });
    boundary.get.mockImplementation(async (url: string, options: { headers?: Record<string, string> }) => {
      const path = new URL(url).pathname;
      expect(options.headers).not.toHaveProperty('Authorization');
      expect(options.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
        target, installationId: 'installation', requestId: envelope.requestId, method: 'GET', path,
        publicKey: keys.publicKey, signature: String(options.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({
        id: sessionId, encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'skill-host' }),
      }) } };
      throw new Error(`Unexpected signed skill read: ${path}`);
    });
    const deps = createCliActionDeps({ token: 'requester-bearer', credentials: { token: 'requester-bearer', encryption: null },
      sessionId: sourceSessionId, mode: 'plain', ctx: null, serverId: 'home', serverIdentityId: 'home',
      serverHttpBaseUrl: 'https://home.example.test', externalActionMachineRequestPrivateKey: keys.secretKey,
      externalActionMachineInstallationId: 'installation', sessionActionRpcTransport: async invocation => {
        expect(invocation).toMatchObject({ sessionId, method: actionId, input: request,
          origin: { caller: context.actionCaller, requestId: envelope.requestId } });
        return result;
      } });
    await expect(deps.skillsRead!(request, context)).resolves.toEqual(result);
  });
  it('reads the delivered session identity then decrypts the selected Artifact through the real store', async () => {
    const { computePromptBundleDigestV1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryDigests');
    const skillMd = '---\nname: review\ndescription: Review\n---\nFull instructions';
    const body = { v: 1 as const, createdAtMs: 1, updatedAtMs: 1, entries: [
      { path: 'SKILL.md', contentBase64: Buffer.from(skillMd).toString('base64'), contentKind: 'utf8' as const },
      { path: 'references/note.bin', contentBase64: 'AAEC/w==', contentKind: 'binary' as const, unixMode: 0o755 },
      { path: 'scripts/check.py', contentBase64: Buffer.from('print("QA_SHIP_SCRIPT_OK")\n').toString('base64'), contentKind: 'utf8' as const, unixMode: 0o755 },
    ] };
    const { createSkillStore } = await import('@/prompts/skills/store/skillStore');
    const items = [{ skillId: 'selected', name: 'review', digest: computePromptBundleDigestV1(body), files: body.entries }];
    const ensured = await createSkillStore({ happyHomeDir: boundary.taskHome }).ensureSkillSessionDir({
      ownerKey: 'active-session', items, nativeDisables: [],
    });
    expect(ensured.failed).toEqual([]);
    const sessionItems = items.map(({ skillId, name, digest }) => ({ skillId, name, digest }));
    // An unrelated plugin source outage must not block an addressed Session skill.
    // The real Account plugin reader remains active beneath this HTTP boundary.
    boundary.post.mockRejectedValue(new Error('Plugin inventory HTTP unavailable'));
    boundary.get.mockImplementation(async (url: string) => ({ status: 200, data:
      url.endsWith(PROMPT_LIBRARY_ROWS_ROUTE_V1) ? { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
        key, revision: 1, content: { t: 'plain', v: key === 'skill-usage' ? { key, value: { v: 1, lastUsedAt: { selected: 123 } } } : emptyPromptLibraryRecordV1(key) },
      })) } : url.endsWith('/v2/account/settings') ? { content: { t: 'plain', v: {} }, version: 1 }
      : url.endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
      : url.endsWith('/v1/artifacts/selected') ? { id: 'selected', ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: 'Review', bundleSchemaId: 'skills.skill_md_v1' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }
      : createAccountEncryptionCurrentnessFixture(),
    }));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    runWithServerHttpBaseUrl('https://home.example.test', () => setActiveAccountSettingsSnapshot({ source: 'network',
      scopeKey: resolveAccountSettingsScopeKey({ token, encryption: null }), settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 1, settingsSecretsReadKeys: [], loadedAtMs: 1 }));
    const recorded: unknown[] = [];
    const daemon = createServer(async (request, response) => {
      if (request.url !== '/skills/usage') { response.writeHead(404).end(); return; }
      let body = ''; for await (const chunk of request) body += chunk;
      recorded.push(RecordSkillUseInputSchema.parse(JSON.parse(body))); response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(RecordSkillUseResultSchema.parse({ ok: true })));
    });
    await new Promise<void>(resolve => daemon.listen(0, '127.0.0.1', resolve));
    const address = daemon.address(); if (!address || typeof address === 'string') throw new Error('Missing daemon fixture address');
    writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(), startedWithCliVersion: 'test', controlToken: 'test' });
    let currentItems: typeof sessionItems | null = sessionItems;
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'active-session', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.example.test',
      getCurrentSessionMetadata: () => ({ machineId: 'skill-host', path: '/repo' }),
      getCurrentSessionSkillItems: () => currentItems }));
    try {
    const inventory = createHappierToolInventory({ surface: 'agent', isActionEnabled: () => true, actionsSettings: null });
    const toolInventory = prepareHappierMcpToolInventory({ sessionId: 'active-session', inventory: {
      ...inventory, tools: inventory.tools.filter(tool => tool.name === 'skills_read'),
    } });
    const bridge = createActionToolExecutorBridge({ executor, surface: 'agent', actionToolNameToId: toolInventory.actionToolNameToId });
    const mcpServer = new McpServer({ name: 'skill-read-contract', version: '1' });
    registerHappierMcpBuiltInTools({ registerTool: (name, meta, handler) => {
      mcpServer.registerTool(name, meta as { inputSchema: z.ZodMiniType }, async (args, extra) => CallToolResultSchema.parse(await handler(args, extra)));
    } }, { sessionId: 'active-session', surface: 'agent', toolInventory,
      deps: { ...bridge, resolveActionOptions: args => bridge.resolveActionOptions(args, 'active-session'),
        changeTitle: async () => ({ success: true }) } });
    const client = new Client({ name: 'skill-read-contract', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);
      const advertised = (await client.listTools()).tools.find(tool => tool.name === 'skills_read');
      if (!advertised) throw new Error('skills_read was not advertised');
      expect(advertised.inputSchema.type).toBe('object');
      for (const key of ['oneOf', 'anyOf', 'allOf']) expect(advertised.inputSchema).not.toHaveProperty(key);
      const acceptsAdvertisedInput = compilePluginJsonSchema(advertised.inputSchema);
      // These are the actual name/id requests recorded from the SHIP-03 Codex Agent.
      // Both must survive the advertised MCP validator, contextual binding and real read owner.
      for (const identity of [{ name: 'review' }, { skillId: 'selected' }]) {
        const args = { ...identity, includeFileContents: true };
        expect(acceptsAdvertisedInput(args)).toBe(true);
        expect(SkillReadInputV1Schema.safeParse(bindContextualActionToolInput({ actionId: 'skills.read', input: args,
          context: { defaultSessionId: 'active-session' } })).success).toBe(true);
        const reply = await client.callTool({ name: 'skills_read', arguments: args });
        expect(reply, JSON.stringify(reply)).toMatchObject({ isError: false, structuredContent: {
          skillId: 'selected', skillMd, fileContents: body.entries,
        } });
        expect(SkillReadResultV1Schema.parse(reply.structuredContent).files).toContainEqual({ path: 'scripts/check.py',
          bytes: Buffer.from('print("QA_SHIP_SCRIPT_OK")\n').length, unixMode: 0o755 });
      }
      expect(await client.callTool({ name: 'skills_read', arguments: { name: 'review', file: 'scripts/check.py' } }))
        .toMatchObject({ isError: false, structuredContent: { skillId: 'selected',
          file: { path: 'scripts/check.py', contentBase64: body.entries[2]!.contentBase64, unixMode: 0o755 } } });
      // Union correlations remain strict at the real MCP call boundary.
      expect(await client.callTool({ name: 'skills_read', arguments: { name: 'review', skillId: 'selected' } }))
        .toMatchObject({ isError: true });
      expect(acceptsAdvertisedInput({ name: 'review', sessionId: '' })).toBe(false);
      expect(acceptsAdvertisedInput({ name: 'review', unexpected: true })).toBe(false);
      expect(await client.callTool({ name: 'skills_read', arguments: { name: 'outside', includeFileContents: true } }))
        .toMatchObject({ isError: true });
      // Natural deploy requests inherit this admitted skill without selecting it.
      // The real session-bound MCP route returns the body directly, with no shell.
      const deploy = readReadOnlySkillContentV1('happier:deploy')!;
      currentItems = [{ skillId: 'happier:deploy', name: 'deploy', digest: deploy.digest }];
      expect(await client.callTool({ name: 'skills_read', arguments: { name: 'deploy' } }))
        .toMatchObject({ isError: false, structuredContent: { skillId: 'happier:deploy', skillMd: deploy.skillMd } });
      currentItems = sessionItems;
    } finally { await client.close(); await mcpServer.close(); }
    recorded.length = 0;
    const result = await executor.execute('skills.read', { name: 'review', sessionId: 'active-session', file: 'references/note.bin' },
      { surface: 'mcp', authority: 'account_automation' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
        skillId: 'selected', skillMd, lastUsedAt: 123, file: { contentBase64: 'AAEC/w==', unixMode: 0o755 },
      } });
    expect(recorded).toEqual([{ skillIds: ['selected'], account: { accountId: 'account', serverHttpBaseUrl: 'https://home.example.test' } }]);
    await executor.execute('skills.read', { skillId: 'selected' }, { surface: 'ui' });
    const reads = boundary.get.mock.calls.filter(([url]) => url.endsWith('/v1/artifacts/selected')).length;
    expect(await executor.execute('skills.read', { name: 'outside', sessionId: 'active-session' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    expect(boundary.get.mock.calls.filter(([url]) => url.endsWith('/v1/artifacts/selected'))).toHaveLength(reads);
    expect(await executor.execute('skills.read', { name: 'review', sessionId: 'active-session', file: 'missing' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    currentItems = [{ ...sessionItems[0]!, skillId: 'plugin:external/review' }];
    expect(await executor.execute('skills.read', { name: 'review', sessionId: 'active-session' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'skill_content_unavailable' });
    currentItems = [{ ...sessionItems[0]!, digest: 'sha256:stale' }];
    expect(await executor.execute('skills.read', { name: 'review', sessionId: 'active-session' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    currentItems = sessionItems;
    const homeRead = boundary.get.getMockImplementation()!;
    boundary.get.mockImplementation(async (url: string, ...args: unknown[]) => {
      const result = await homeRead(url, ...args);
      if (url.endsWith('/v1/artifacts/selected')) currentItems = null;
      return result;
    });
    expect(await executor.execute('skills.read', { name: 'review', sessionId: 'active-session' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    expect(recorded).toEqual([{ skillIds: ['selected'], account: { accountId: 'account', serverHttpBaseUrl: 'https://home.example.test' } }]);
    } finally { await new Promise<void>((resolve, reject) => daemon.close(error => error ? reject(error) : resolve())); }
  });
});
