import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import nacl from 'tweetnacl';
import { buildHappierReplayPromptFromDialog } from '@happier-dev/agents';
import {
  deriveAccountMachineKeyFromRecoverySecret,
  sealEncryptedDataKeyEnvelopeV1,
  sealSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
  TranscriptRawRecordV1Schema,
  accountSettingsParse,
} from '@happier-dev/protocol';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { HAPPIER_REPLAY_MIN_SEED_CHARS } from '@happier-dev/protocol/sessions/replay-seed-budget';
import { sealSessionStoredContent } from '@/session/transport/encryption/sessionEncryptionContext';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { encodeBase64 } from '@/api/encryption';
import { respondTranscriptMessagesQueryRejection } from '@/testkit/transcript/transcriptMessagesRouteContract';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

// HTTP is the system boundary; recipe, source hydration, decryption and framing remain real.
describe('replay seed recipe budget through real source hydration', () => {
  let server: Server | null = null;
  let happyHomeDir = '';
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR']);

  beforeEach(async () => {
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR']);
    happyHomeDir = await createTempDir('happier-cli-replay-budget-');
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => {
      server!.close(error => error ? reject(error) : resolve());
    });
    server = null;
    if (happyHomeDir) await removeTempDir(happyHomeDir);
    envScope.restore();
    (await import('@/configuration')).reloadConfiguration();
  });

  it.each(['stored small budget', 'minimum seed budget'] as const)('builds a replay fork recipe from real sealed layout-v1 records at the %s', async (scenario) => {
    const sessionId = scenario === 'minimum seed budget' ? 's' : 'sess_layout_v1_replied';
    const secret = new Uint8Array(32).fill(9);
    const dataKey = new Uint8Array(32).fill(21);
    const ownerMetadata = sealSessionOwnerMetadataEnvelopeV1({
      material: { type: 'legacy', secret },
      ownerMetadata: SessionOwnerMetadataV1Schema.parse({ v: 1 }),
      randomBytes: length => new Uint8Array(length).fill(5),
    });
    const session = {
      id: sessionId, seq: 2, createdAt: 100, updatedAt: 200,
      active: false, activeAt: 0, archivedAt: null,
      encryptionMode: 'e2ee', metadataLayoutVersion: 1,
      metadata: JSON.stringify({ v: 1 }), metadataVersion: 0, ownerMetadata,
      agentState: null, agentStateVersion: 0, pendingCount: 0, pendingVersion: 0,
      dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
        dataKey,
        recipientPublicKey: nacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey,
        randomBytes: length => new Uint8Array(length).fill(5),
      })),
      share: null,
    };
    const records = scenario === 'minimum seed budget' ? [
      TranscriptRawRecordV1Schema.parse({ role: 'agent', content: { type: 'output', data: {
        type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
      } } }),
    ] : [
      TranscriptRawRecordV1Schema.parse({ role: 'user', content: { type: 'text', text: 'Explain the completed work' } }),
      TranscriptRawRecordV1Schema.parse({ role: 'agent', content: { type: 'output', data: {
        type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The work is complete' }] },
      } } }),
    ];
    const page = SessionMessagesPageV1Schema.parse({
      messages: records.map((payload, index) => ({
        id: `message-${index + 1}`, seq: index + 1, createdAt: 100 + index,
        content: sealSessionStoredContent({ mode: 'e2ee', ctx: { encryptionVariant: 'dataKey', encryptionKey: dataKey }, payload }),
      })),
      hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
    });
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/v1/account/encryption/currentness') {
        res.end(JSON.stringify({ mode: 'e2ee', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
      } else if (url.pathname === `/v2/sessions/${sessionId}`) {
        res.end(JSON.stringify({ session }));
      } else if (url.pathname === `/v1/sessions/${sessionId}/messages`) {
        if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
        res.end(JSON.stringify(page));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve server address');
    envScope.patch({ HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}`, HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000', HAPPIER_HOME_DIR: happyHomeDir });
    (await import('@/configuration')).reloadConfiguration();

    const { buildReplaySeededSpawnRecipe } = await import('./buildReplaySeededSpawnRecipe');
    const minimumSeedBudget = buildHappierReplayPromptFromDialog({
      previousSessionId: 's', strategy: 'recent_messages', recentMessagesCount: null,
      dialog: [{ role: 'Assistant', createdAt: 100, text: 'x' }],
    }).length;
    expect(minimumSeedBudget).toBe(HAPPIER_REPLAY_MIN_SEED_CHARS);
    const maxSeedChars = accountSettingsParse({ sessionReplayMaxSeedChars:
      scenario === 'stored small budget' ? 1024 : minimumSeedBudget }).sessionReplayMaxSeedChars;
    const result = await buildReplaySeededSpawnRecipe({
      credentials: { token: 't', encryption: { type: 'legacy', secret } },
      cwd: happyHomeDir, source: { sourceSessionId: sessionId, forkPoint: { type: 'seq', upToSeqInclusive: 2 } },
      agentHintAgentId: 'claude', lineageCutoffSeqInclusive: 2,
      maxSeedChars,
    });
    expect(result.ok, result.ok ? undefined : result.errorMessage).toBe(true);
    if (!result.ok) return;
    expect(result.recipe.seedText.length).toBeLessThanOrEqual(maxSeedChars);
    if (scenario === 'minimum seed budget') {
      expect(maxSeedChars).toBe(minimumSeedBudget);
      expect(result.recipe.seedText).toContain('Assistant: x');
    } else {
      expect(maxSeedChars).toBe(1024);
      expect(result.recipe.seedText).toContain('Explain the completed work');
      expect(result.recipe.seedText).toContain('The work is complete');
    }
    expect(result.recipe.cutoffSeqInclusive).toBe(2);
    expect(result.recipe.metadata.forkV1).toMatchObject({ parentSessionId: sessionId, parentCutoffSeqInclusive: 2, strategy: 'replay' });
    const consumed = SessionOwnerMetadataV1Schema.parse({ v: 1, history: {
      forkV1: result.recipe.metadata.forkV1, replaySeedV1: result.recipe.metadata.replaySeedV1,
    } });
    expect(consumed.history?.replaySeedV1?.seedText).toBe(result.recipe.seedText);
    const refused = await buildReplaySeededSpawnRecipe({
      credentials: { token: 't', encryption: { type: 'legacy', secret } }, cwd: happyHomeDir,
      source: { sourceSessionId: sessionId, forkPoint: { type: 'seq', upToSeqInclusive: 2 } },
      agentHintAgentId: 'claude', maxSeedChars: minimumSeedBudget - 1,
    });
    expect(refused).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    if (!refused.ok) expect(refused.errorMessage).toContain('budget');
  });

});
