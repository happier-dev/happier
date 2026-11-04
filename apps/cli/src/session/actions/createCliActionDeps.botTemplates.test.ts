import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { BotTemplateFollowResultV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1,
  projectSessionSharedMetadataV1, projectSessionOwnerCompatibilityViewV1,
  SessionMetadataOwnerPatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture,
  createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from './createCliActionDeps';
import { configuration } from '@/configuration';

afterEach(() => vi.restoreAllMocks());

describe('CLI template private Session transport', () => {
  it('stops following through the private field writer while preserving instructions and other owner work', async () => {
    const accountId = 'template-recipient';
    const serverId = configuration.activeServerId;
    const sessionId = 'c000000000000000000000003';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const instance = BotTemplateFollowResultV1Schema.shape.instance.parse({ v: 1,
      source: { kind: 'artifact', serverId, artifactId: '80f7dabe-1f05-44b7-8e44-d98f2127f523' }, acceptedVersion: '1.0.0',
      acceptedBase: { serverId, artifactId: '70f7dabe-1f05-44b7-8e44-d98f2127f523' }, skillIds: {}, mcpServerIds: {}, follow: true });
    const metadata = { host: 'host', path: '/repo', machineId: 'machine', work: { templateInstance: instance,
      promptStack: [{ id: 'session.instructions', ref: { kind: 'doc' as const, serverId,
        artifactId: '60f7dabe-1f05-44b7-8e44-d98f2127f523' }, enabled: true, placement: 'system_append' as const }] } };
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error('Invalid owner metadata fixture');
    let row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: false,
      ownerAccountId: accountId, metadataLayoutVersion: 1, share: null,
      metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata, agentState: null })),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata) });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected GET ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, input) => {
      if (new URL(String(url)).pathname === '/v2/sessions/read-batch') return { status: 200,
        data: createSessionReadBatchResponseFixture({ request: input, sessions: [row] }) };
      throw new Error('Unexpected POST');
    });
    vi.spyOn(axios, 'patch').mockImplementation(async (_url, input) => {
      const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
      expect(patch.expectedOwnerMetadata).toEqual(row.ownerMetadata);
      row = { ...row, ownerMetadata: patch.ownerMetadata, metadata: patch.sharedMetadata.ciphertext,
        metadataVersion: row.metadataVersion + 1, agentState: patch.agentState.ciphertext,
        agentStateVersion: (row.agentStateVersion ?? 0) + 1 };
      return { status: 200, data: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
    });
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId, serverId, serverHttpBaseUrl: configuration.apiServerUrl, mode: 'plain', ctx: null }));
    expect(await executor.execute('template.follow.stop', { sessionRef: { serverId, sessionId } },
      { surface: 'cli', authority: 'present_user', serverId })).toMatchObject({ ok: true, result: { changed: true } });
    if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected plain private metadata');
    const persisted = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(row.metadata!), ownerMetadata: row.ownerMetadata.v });
    expect(persisted.work).toEqual({ ...metadata.work, templateInstance: { ...instance, follow: false } });
  });
});
