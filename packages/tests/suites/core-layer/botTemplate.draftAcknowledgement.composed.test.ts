import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod/mini';
import { createActionExecutor, createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1,
  decodePlainArtifactStoredContent, projectSessionSharedMetadataV1, SessionMetadataOwnerPatchV1Schema,
  type V2SessionRecord } from '@happier-dev/protocol';
import { createCliActionDeps } from '../../../../apps/cli/src/session/actions/createCliActionDeps';
import { registerAccountHomeHttp } from '../../../../apps/cli/src/session/actions/widgetApproval.testkit';
import { createSessionNotificationContextFixture } from '../../../../apps/cli/src/testkit/backends/sessionFixtures';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { BotTemplateDraftV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { readBotTemplateDraftResult } from '../../../../apps/ui/sources/components/sessions/bots/templates/readBotTemplateDraftResult';

interface ServerHome {
  accountId: string;
  token: string;
  serverUrl: string;
  close(): Promise<void>;
}
interface ServerTestkit {
  createHome(options: { configureHttp(app: FastifyInstance, accountId: string): void }): Promise<ServerHome>;
  close(): Promise<void>;
}

// Keep the Server compiler boundary, as in confidentialOrigin.composed.test.ts.
const serverTestkitPath = '../../../../apps/server/sources/testkit/approvalOriginServer.testkit';
let server: ServerTestkit;
beforeAll(async () => {
  const module = await import(serverTestkitPath) as { createApprovalOriginServerTestkit(): Promise<ServerTestkit> };
  server = await module.createApprovalOriginServerTestkit();
});
afterAll(async () => { await server?.close(); });

it('acknowledges the persisted agent template draft through real CLI Action and Artifact HTTP', async () => {
  const sourceSessionRef = { serverId: 'draft-home', sessionId: 'source-bot' };
  const metadata = {};
  const owner = createSessionOwnerMetadataV1({ metadata });
  if (!owner.ok) throw new Error('Unsupported source metadata fixture');
  let session: V2SessionRecord = { ...createSessionNotificationContextFixture(sourceSessionRef.sessionId),
    encryptionMode: 'plain', metadataLayoutVersion: 1,
    metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
    ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata) };
  const createdIds: string[] = [];
  const home = await server.createHome({ configureHttp: (app, accountId) => {
    // Only Account/Session HTTP facts are fixtures. Artifact authentication,
    // write admission, serialization and disposable SQLite persistence stay real.
    const features = registerAccountHomeHttp(app, { accountId, serverId: 'srv_draft_ack' });
    app.get('/v1/features', async () => features);
    app.get(`/v2/sessions/${sourceSessionRef.sessionId}`, async () => ({ session }));
    app.patch(`/v2/sessions/${sourceSessionRef.sessionId}`, async request => {
      const patch = SessionMetadataOwnerPatchV1Schema.parse(request.body);
      expect(patch.expectedOwnerMetadata).toEqual(session.ownerMetadata);
      session = { ...session, metadata: patch.sharedMetadata.ciphertext, ownerMetadata: patch.ownerMetadata,
        agentState: patch.agentState.ciphertext, metadataVersion: session.metadataVersion + 1,
        agentStateVersion: session.agentStateVersion + 1 };
      return { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: session.metadataVersion },
        agentState: { version: session.agentStateVersion } };
    });
    app.addHook('onSend', async (request, _reply, payload) => {
      if (request.method !== 'POST' || request.url !== '/v1/artifacts' || typeof payload !== 'string') return payload;
      const acknowledgement = JSON.parse(payload) as Record<string, unknown>;
      if (typeof acknowledgement.id === 'string') createdIds.push(acknowledgement.id);
      // Historical POST omitted this fact (BT-QA2 F3). Subtract only at the
      // serialized network boundary to prove sensitivity without changing owners.
      if (process.env.HAPPIER_TEST_SUBTRACT_DRAFT_CREATE_AUDIENCE === '1') {
        delete acknowledgement.publicAudience;
        return JSON.stringify(acknowledgement);
      }
      return payload;
    });
  } });
  try {
    await runWithServerHttpBaseUrl(home.serverUrl, async () => {
      const executor = createActionExecutor(createCliActionDeps({ token: home.token,
        credentials: { token: home.token, encryption: null }, sessionId: sourceSessionRef.sessionId,
        mode: 'plain', ctx: null, serverId: sourceSessionRef.serverId, serverHttpBaseUrl: home.serverUrl }));
      const content = { v: 1 as const, identity: { name: 'Draft acknowledgement', description: 'Reusable helper' },
        instructions: { markdown: 'Help with work.' }, memoryRules: [], skills: [],
        needs: { software: [], connectedAccounts: [], mcpServers: [] } };
      const drafted = await executor.execute('template.draft', { sourceSessionRef, content }, {
        surface: 'agent', authority: 'account_automation', serverId: sourceSessionRef.serverId });
      expect(createdIds).toHaveLength(1);
      const draftArtifactId = createdIds[0]!;
      const persisted = await fetch(`${home.serverUrl}/v1/artifacts/${draftArtifactId}`, {
        headers: { authorization: `Bearer ${home.token}` },
      });
      expect(persisted.status).toBe(200);
      const artifact = await persisted.json() as { body: string; publicAudience: string };
      expect(artifact.publicAudience).toBe('none');
      const storedBody = z.object({ body: z.string() }).parse(decodePlainArtifactStoredContent(artifact.body));
      expect(BotTemplateDraftV1Schema.parse(JSON.parse(storedBody.body))).toMatchObject({ state: 'draft', sourceSessionRef, content });
      expect(session.ownerMetadata).toMatchObject({ t: 'plain', v: { work: {
        templateDraftRef: { serverId: sourceSessionRef.serverId, artifactId: draftArtifactId },
      } } });
      expect(drafted, drafted.ok ? undefined : drafted.errorCode).toMatchObject({ ok: true, result: { draftArtifactId,
        revision: { headerVersion: 1, bodyVersion: 1 }, sourceSessionRef } });
      const updatedContent = { ...content, instructions: { markdown: 'Help with the next task.' } };
      const updated = await executor.execute('template.draft', { sourceSessionRef, content: updatedContent }, {
        surface: 'agent', authority: 'account_automation', serverId: sourceSessionRef.serverId });
      expect(updated, updated.ok ? undefined : updated.errorCode).toMatchObject({ ok: true, result: { draftArtifactId,
        revision: { headerVersion: 2, bodyVersion: 2 }, sourceSessionRef } });
      expect(readBotTemplateDraftResult({ id: 'draft-update', name: 'happier_action_execute', state: 'completed',
        input: { actionId: 'template.draft', input: { sourceSessionRef, content: updatedContent } }, result: updated,
        createdAt: 0, startedAt: 0, completedAt: 0, description: null })).toMatchObject({ draftArtifactId,
        revision: { headerVersion: 2, bodyVersion: 2 }, sourceSessionRef, summary: { identity: updatedContent.identity } });
      expect(createdIds).toEqual([draftArtifactId]);
      const current = await fetch(`${home.serverUrl}/v1/artifacts/${draftArtifactId}`, {
        headers: { authorization: `Bearer ${home.token}` },
      });
      expect(current.status).toBe(200);
      const currentArtifact = await current.json() as { body: string; headerVersion: number; bodyVersion: number };
      expect(currentArtifact).toMatchObject({ headerVersion: 2, bodyVersion: 2 });
      const currentBody = z.object({ body: z.string() }).parse(decodePlainArtifactStoredContent(currentArtifact.body));
      expect(BotTemplateDraftV1Schema.parse(JSON.parse(currentBody.body))).toMatchObject({ content: updatedContent });
    });
  } finally { await home.close(); }
});
