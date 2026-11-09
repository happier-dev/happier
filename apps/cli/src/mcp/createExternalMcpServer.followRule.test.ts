import { describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { encodeV2SessionListCursorV1, FeaturesResponseSchema } from '@happier-dev/protocol';
import { SessionFollowActionOutputSchemasV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { configuration } from '@/configuration';
import { readStoredCredentialsForServerId, removeStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture, createCompactSessionListQueryResponseFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createExternalMcpServer } from './createExternalMcpServer';

describe('external MCP rule Account custody composition', () => {
  it.each(['get', 'preview', 'captured-preview', 'denied-project-preview'] as const)('executes rule %s through real MCP, Action, HTTP, listing and Account owners', async operation => {
    const serverId = configuration.activeServerId;
    const previous = await readStoredCredentialsForServerId(serverId);
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'rule-owner' })).toString('base64url')}.signature`,
      credentialProvenance: 'stored_session' as const, encryption: null };
    await writeStoredCredentialsForServerId(serverId, credentials);
    const app = fastify();
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://follow.test' });
    const receiver = { kind: 'account' as const };
    const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: [serverId] }), policy: { preset: 'important' as const } };
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture());
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    let projectReads = 0;
    app.post('/v1/account/project-rows/list', async (_request, reply) => {
      projectReads++;
      return reply.code(403).send({ error: 'credential_scope_denied' });
    });
    let sourcePages = 0;
    const sourceRows = [
      { ...createSessionNotificationContextFixture('workspace-only'), ownerAccountId: 'rule-owner',
        origin: { kind: 'none' as const }, encryptionMode: 'plain' as const, metadata: JSON.stringify({ workspaceId: 'unavailable-ref' }) },
      { ...createSessionNotificationContextFixture('matching'), ownerAccountId: 'rule-owner', origin: { kind: 'none' as const },
        encryptionMode: 'plain' as const, projectKey: 'payments', metadata: JSON.stringify({}) },
      { ...createSessionNotificationContextFixture('locked'), ownerAccountId: 'rule-owner', origin: { kind: 'none' as const }, metadata: 'unreadable-ciphertext' },
    ];
    app.post('/v2/sessions/read-batch', async request => createSessionReadBatchResponseFixture({ request: request.body, sessions: sourceRows }));
    app.post('/v2/sessions/query', async request => {
      expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
      sourcePages++;
      if (operation === 'captured-preview' && sourcePages === 1) {
        await writeStoredCredentialsForServerId(serverId, { ...credentials,
          token: `header.${Buffer.from(JSON.stringify({ sub: 'replacement-owner' })).toString('base64url')}.signature` });
      }
      if (operation === 'denied-project-preview') return createCompactSessionListQueryResponseFixture({
        sessions: [sourceRows[0]!],
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      });
      const continuing = Object.hasOwn(request.body as object, 'cursor');
      return createCompactSessionListQueryResponseFixture({ sessions: [sourceRows[continuing ? 1 : 2]!],
        nextCursor: continuing ? null : encodeV2SessionListCursorV1('locked'), hasNext: !continuing,
        attentionNextCursor: null, attentionHasNext: false });
    });
    let privateReads = 0;
    app.get('/v2/account/session-follow-rules/:ruleId', async request => {
      expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
      privateReads++;
      return { rule: { ruleId: 'personal-rule', receiver, content: { t: 'plain', v: definition }, version: 2 } };
    });
    const runtime = runWithServerHttpBaseUrl('http://follow.test', () => createExternalMcpServer({ credentials,
      serverFeaturesSnapshot: { status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, following: { enabled: true } } }, capabilities: {},
      }) },
    }));
    const client = new Client({ name: 'follow-rule-composition', version: '1' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await runtime.mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: operation === 'get' ? {
        actionId: 'follow.get', input: { receiver, source: { kind: 'rule', ruleId: 'personal-rule' } },
      } : { actionId: 'follow.preview', input: { receiver, filter: normalizeSessionListFilterV1({ homeServerIds: [serverId],
        projects: { include: [{ serverId, projectKey: 'payments' }], exclude: [] },
      }) } } }));
      const content = result.content.find(item => item.type === 'text');
      if (!content || content.type !== 'text') throw new Error('Missing Action result');
      expect(result.isError).toBe(false);
      if (operation === 'get') {
        expect(SessionFollowActionOutputSchemasV1['follow.get'].parse(JSON.parse(content.text)))
          .toEqual({ rule: { ruleId: 'personal-rule', receiver, version: 2, definition } });
        expect(privateReads).toBe(1);
      } else {
        if (operation === 'denied-project-preview') {
          expect(SessionFollowActionOutputSchemasV1['follow.preview'].parse(JSON.parse(content.text))).toMatchObject({
            coverage: 'partial', matchCount: 0, matches: [],
            unavailable: [{ serverId, source: { kind: 'session', sessionId: 'workspace-only' } }],
          });
          expect(projectReads).toBe(1);
          return;
        }
        expect(SessionFollowActionOutputSchemasV1['follow.preview'].parse(JSON.parse(content.text))).toMatchObject({
          coverage: 'partial', matchCount: 1, matches: [{ serverId, source: { kind: 'session', sessionId: 'matching' } }],
          unavailable: [{ serverId, source: { kind: 'session', sessionId: 'locked' } }],
        });
        expect(sourcePages).toBe(2);
        expect(privateReads).toBe(0);
      }
    } finally {
      await client.close();
      await runtime.mcp.close();
      restore();
      await app.close();
      if (previous) await writeStoredCredentialsForServerId(serverId, previous);
      else await removeStoredCredentialsForServerId(serverId);
    }
  });
});
