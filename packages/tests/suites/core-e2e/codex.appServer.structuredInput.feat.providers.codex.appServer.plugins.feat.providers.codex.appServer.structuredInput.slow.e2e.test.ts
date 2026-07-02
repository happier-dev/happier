import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  readFakeCodexAppServerRequestLog,
  startCodexAppServerRemoteHarness,
  type StartedCodexAppServerRemoteHarness,
} from '../../src/testkit/codexAppServerRemoteHarness';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchMessagesSince, fetchSessionV2 } from '../../src/testkit/sessions';
import { callLegacyEncryptedSessionRpc } from '../../src/testkit/sessionRpc';
import { createUserScopedSocketCollector, type SocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

type CatalogParseResult<T> = { success: true; data: T } | { success: false };
type RuntimeVendorPluginCatalog = Readonly<{
  supported?: boolean;
  unsupported?: boolean;
  vendorPlugins: ReadonlyArray<Record<string, unknown>>;
}>;
type RuntimeSkillCatalog = Readonly<{
  supported?: boolean;
  unsupported?: boolean;
  skills: ReadonlyArray<Record<string, unknown>>;
}>;

const RuntimeVendorPluginCatalogSchema = {
  safeParse(input: unknown): CatalogParseResult<RuntimeVendorPluginCatalog> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { success: false };
    const record = input as Record<string, unknown>;
    if (!Array.isArray(record.vendorPlugins)) return { success: false };
    return {
      success: true,
      data: {
        ...(typeof record.supported === 'boolean' ? { supported: record.supported } : {}),
        ...(typeof record.unsupported === 'boolean' ? { unsupported: record.unsupported } : {}),
        vendorPlugins: record.vendorPlugins.filter((entry): entry is Record<string, unknown> => {
          return !!entry && typeof entry === 'object' && !Array.isArray(entry);
        }),
      },
    };
  },
};

const RuntimeSkillCatalogSchema = {
  safeParse(input: unknown): CatalogParseResult<RuntimeSkillCatalog> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { success: false };
    const record = input as Record<string, unknown>;
    if (!Array.isArray(record.skills)) return { success: false };
    return {
      success: true,
      data: {
        ...(typeof record.supported === 'boolean' ? { supported: record.supported } : {}),
        ...(typeof record.unsupported === 'boolean' ? { unsupported: record.unsupported } : {}),
        skills: record.skills.filter((entry): entry is Record<string, unknown> => {
          return !!entry && typeof entry === 'object' && !Array.isArray(entry);
        }),
      },
    };
  },
};

async function connectUserSocket(params: Readonly<{
  baseUrl: string;
  token: string;
}>): Promise<SocketCollector> {
  const socket = createUserScopedSocketCollector(params.baseUrl, params.token);
  socket.connect();
  try {
    await waitFor(async () => socket.isConnected(), {
      timeoutMs: 15_000,
      context: 'connect user-scoped socket for Codex app-server structured input e2e',
    });
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function enqueuePromptAndWaitForTranscript(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  afterSeq: number;
  text: string;
}>): Promise<void> {
  const localId = `pending-${randomUUID()}`;
  const enqueue = await enqueuePendingQueueV2({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    localId,
    ciphertext: encryptLegacyBase64(
      {
        role: 'user',
        content: { type: 'text', text: params.text },
        localId,
        meta: { source: 'ui', sentFrom: 'e2e' },
      },
      params.secret,
    ),
    timeoutMs: 20_000,
  });
  expect(enqueue.status).toBe(200);

  await waitFor(async () => {
    const pending = await listPendingQueueV2({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      timeoutMs: 20_000,
    });
    return pending.status === 200
      && Array.isArray(pending.data?.pending)
      && pending.data.pending.every((row) => row.localId !== localId);
  }, { timeoutMs: 45_000, context: 'Codex app-server drains seed prompt before catalog RPC' });

  await waitFor(async () => {
    const transcriptRows = await fetchMessagesSince({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      afterSeq: params.afterSeq,
    });
    return transcriptRows.some((row) => row.localId === localId);
  }, { timeoutMs: 45_000, context: 'Codex app-server materializes seed prompt before catalog RPC' });
}

describe('core e2e: Codex app-server vendor catalog and structured input', () => {
  let harness: StartedCodexAppServerRemoteHarness | null = null;

  afterEach(async () => {
    await harness?.stop().catch(() => {});
    harness = null;
  });

  it('lists vendor plugin and skill catalogs through session RPC and sends structured mentions and remote images', async () => {
    const testDir = run.testDir('codex-app-server-structured-input');
    harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: run.runId,
      testName: 'codex-app-server-structured-input',
    });
    const { auth, requestLogPath, secret, serverBaseUrl, sessionId, workspaceDir } = harness;
    const baselineSeq = harness.readySession.seq ?? 0;

    await enqueuePromptAndWaitForTranscript({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      afterSeq: baselineSeq,
      text: `start app-server thread before catalog RPC ${randomUUID()}`,
    });

    const socket = await connectUserSocket({ baseUrl: serverBaseUrl, token: auth.token });
    try {
      const vendorCatalog = await callLegacyEncryptedSessionRpc({
        ui: socket,
        sessionId,
        method: SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST,
        req: {},
        secret,
        schema: RuntimeVendorPluginCatalogSchema,
        timeoutMs: 45_000,
      });
      expect(vendorCatalog.vendorPlugins).toEqual(expect.arrayContaining([
        expect.objectContaining({
          displayName: 'Reviewer',
          vendorPluginRef: 'plugin://reviewer@codex',
          installed: true,
          enabled: true,
          mentionable: true,
        }),
      ]));

      const skillCatalog = await callLegacyEncryptedSessionRpc({
        ui: socket,
        sessionId,
        method: SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST,
        req: {},
        secret,
        schema: RuntimeSkillCatalogSchema,
        timeoutMs: 45_000,
      });
      expect(skillCatalog.skills).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'code-review',
          path: expect.stringContaining('/skills/code-review/SKILL.md'),
          enabled: true,
          origin: 'codex_native',
        }),
      ]));
    } finally {
      socket.close();
    }

    const localId = `pending-${randomUUID()}`;
    const userText = `structured input ${randomUUID()}`;
    const skillPath = resolve(testDir, 'skills', 'code-review', 'SKILL.md');
    const imagePath = resolve(testDir, 'happier', 'uploads', 'session-structured-input', 'messages', 'm1', 'screenshot.png');
    const imageUrl = `https://images.example.test/${randomUUID()}.png`;
    const enqueue = await enqueuePendingQueueV2({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      localId,
      ciphertext: encryptLegacyBase64(
        {
          role: 'user',
          content: { type: 'text', text: userText },
          localId,
          meta: {
            source: 'ui',
            sentFrom: 'e2e',
            happierStructuredInputV1: {
              v: 1,
              vendorPluginMentions: [
                { displayName: 'Reviewer', vendorPluginRef: 'plugin://reviewer@codex' },
              ],
              skillMentions: [
                { name: 'code-review', path: skillPath },
              ],
              attachments: [
                {
                  kind: 'image',
                  mimeType: 'image/png',
                  localPath: imagePath,
                  provenance: { kind: 'sessionAttachmentUpload' },
                },
                { kind: 'image', mimeType: 'image/png', url: imageUrl },
              ],
            },
          },
        },
        secret,
      ),
      timeoutMs: 20_000,
    });
    expect(enqueue.status).toBe(200);

    await waitFor(async () => {
      const pending = await listPendingQueueV2({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        timeoutMs: 20_000,
      });
      return pending.status === 200
        && Array.isArray(pending.data?.pending)
        && pending.data.pending.every((row) => row.localId !== localId);
    }, { timeoutMs: 45_000, context: 'Codex app-server drains structured input prompt' });

    await waitFor(async () => {
      const transcriptRows = await fetchMessagesSince({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        afterSeq: baselineSeq,
      });
      const localRow = transcriptRows.find((row) => row.localId === localId) ?? null;
      if (!localRow) return false;
      const userRecord = decryptLegacyBase64Normalized(localRow.content.c, secret) as Record<string, unknown> | null;
      const content = userRecord?.content as Record<string, unknown> | undefined;
      if (!(userRecord?.role === 'user' && content?.type === 'text' && content.text === userText)) return false;
      const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      return typeof snap.seq === 'number' && snap.seq > baselineSeq;
    }, { timeoutMs: 45_000, context: 'Codex app-server materializes structured input transcript' });

    const requests = await readFakeCodexAppServerRequestLog(requestLogPath);
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'plugin/list',
        params: expect.objectContaining({ cwds: [workspaceDir] }),
      }),
      expect.objectContaining({
        method: 'skills/list',
        params: expect.objectContaining({ cwds: [workspaceDir] }),
      }),
      expect.objectContaining({
        method: 'turn/start',
        params: expect.objectContaining({
          input: expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: expect.stringContaining(userText) }),
            expect.objectContaining({ type: 'mention', path: 'plugin://reviewer@codex' }),
            expect.objectContaining({ type: 'skill', name: 'code-review', path: skillPath }),
            expect.objectContaining({ type: 'image', url: imageUrl }),
          ]),
        }),
      }),
    ]));
    const turnStart = requests.find((entry) => entry.method === 'turn/start');
    const turnInput = Array.isArray(turnStart?.params?.input) ? turnStart.params.input : [];
    expect(turnInput).not.toContainEqual(expect.objectContaining({ type: 'localImage', path: imagePath }));
    const pluginList = requests.find((entry) => entry.method === 'plugin/list');
    expect(pluginList?.params).not.toHaveProperty('forceReload');
  }, 240_000);
});
