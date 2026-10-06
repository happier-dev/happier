import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import tweetnacl from 'tweetnacl';
import { afterAll, describe, expect, it } from 'vitest';

import {
  ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
  AccountApiTokensCreateActionOutputV1Schema,
  formatAccountApiTokenCredentialV1,
  openEncryptedDataKeyEnvelopeV1,
  wrapApiTokenEncryptionAccessV1,
} from '@happier-dev/protocol';
import { connect, HappierTransportError } from '../../../../packages/sdk/src/index.public';
import { createTestAuth, type TestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { fetchJson } from '../../src/testkit/http';
import { startInterruptibleTcpProxy } from '../../src/testkit/network/interruptibleTcpProxy';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveTsxImportHookSpecifier } from '../../src/testkit/process/tsxImportHook';
import { encryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

async function mintCredential(baseUrl: string, auth: TestAuth, sessionId: string, contentAccess: boolean) {
  const tokenId = randomUUID();
  const wrappingSecret = Uint8Array.from(randomBytes(32));
  const features = await fetchJson<{
    capabilities: { serverIdentity: { serverIdentityId: string } };
  }>(`${baseUrl}/v1/features`);
  expect(features.status).toBe(200);
  const identity = JSON.parse(Buffer.from(auth.token.split('.')[1]!, 'base64url').toString('utf8')) as { sub: string };
  const context = {
    tokenId, accountId: identity.sub,
    serverIdentityId: features.data.capabilities.serverIdentity.serverIdentityId,
    contentPublicKey: Buffer.from(tweetnacl.box.keyPair.fromSecretKey(auth.accountMachineKey).publicKey).toString('base64'),
  };
  const encryption = contentAccess ? {
    access: wrapApiTokenEncryptionAccessV1({ context, wrappingSecret, contentPrivateKey: auth.accountMachineKey,
      randomBytes: (length) => Uint8Array.from(randomBytes(length)) }),
  } : undefined;
  const response = await fetchJson<unknown>(`${baseUrl}${ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1}`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenId, label: 'SDK live permission fixture', encryption,
      grant: { v: 1, actions: { families: ['messaging'], ids: ['transcript.follow', 'transcript.unfollow', 'session.transcript.get'] },
        targets: { sessions: [sessionId], machines: [] }, approve: true, origins: [],
        models: null, permissionModes: null, create: null } }),
  });
  expect(response.status).toBe(200);
  const created = AccountApiTokensCreateActionOutputV1Schema.parse(response.data);
  return { tokenId: created.apiToken.tokenId, bearer: created.token,
    credential: contentAccess ? formatAccountApiTokenCredentialV1({
      accountId: context.accountId, serverIdentityId: context.serverIdentityId, contentPublicKey: context.contentPublicKey,
      bearer: created.token,
      wrappingSecret: Buffer.from(wrappingSecret).toString('base64url') }) : created.token };
}

describe('core e2e: SDK live Session permissions and durable convergence', () => {
  let server: StartedServer | null = null;
  afterAll(async () => { await server?.stop(); });

  for (const variant of ['plain-socket', 'e2ee-socket', 'e2ee-polling'] as const) {
    it(`${variant}: allows and denies real prompts, repairs offline rows, and rejects revoked credentials`, async () => {
      const testDir = run.testDir(`sdk-live-session-${variant}`);
      server ??= await startServerLight({ testDir: run.testDir('sdk-live-server'), extraEnv: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      } });
      const baseUrl = server.baseUrl;
      const auth = await createTestAuth(baseUrl);
      const plain = variant === 'plain-socket';
      if (plain) {
        const mode = await fetchJson<unknown>(`${baseUrl}/v1/account/encryption`, {
          method: 'PATCH', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'plain' }),
        });
        expect(mode.status).toBe(200);
      }
      const daemonHome = resolve(testDir, 'daemon-home');
      const workspace = resolve(testDir, 'workspace');
      await mkdir(workspace, { recursive: true });
      await seedCliAuthForTestAccount({ cliHome: daemonHome, serverUrl: baseUrl, auth, mode: plain ? 'tokenOnly' : 'dataKey' });
      const cliRoot = resolve(repoRootDir(), 'apps/cli');
      const hook = resolveTsxImportHookSpecifier();
      if (!hook) throw new Error('Current-source CLI requires the repository tsx import hook');
      const agentEnv = {
        HAPPIER_HOME_DIR: daemonHome, HAPPIER_SERVER_URL: baseUrl, HAPPIER_WEBAPP_URL: baseUrl,
        HAPPIER_VARIANT: 'dev', HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
        HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(testDir, 'fake-claude.jsonl'),
        HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'permission-prompt-write',
      };
      const daemon = await startTestDaemon({ testDir, happyHomeDir: daemonHome,
        env: { ...process.env, ...agentEnv, CI: '1', HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' },
        // No frozen snapshot/package: this daemon and its children consume the moving source checkout.
        cliLaunchSpec: { command: process.execPath, args: ['--import', hook, resolve(cliRoot, 'src/index.ts')],
          cwd: cliRoot, env: { TSX_TSCONFIG_PATH: resolve(cliRoot, 'tsconfig.json') } },
      });
      const artifacts = new FailureArtifacts();
      let client: ReturnType<typeof connect> | undefined;
      let proxy: Awaited<ReturnType<typeof startInterruptibleTcpProxy>> | undefined;
      let passed = false;
      try {
        const spawned = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
          port: daemon.state.httpPort, controlToken: daemon.state.controlToken, path: '/spawn-session',
          body: { directory: workspace, backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            terminal: { mode: 'plain' }, environmentVariables: agentEnv },
        });
        expect(spawned.status).toBe(200);
        expect(spawned.data.success).toBe(true);
        const sessionId = spawned.data.sessionId;
        if (!sessionId) throw new Error('Daemon did not return the created Session id');
        const initial = await fetchSessionV2(baseUrl, auth.token, sessionId);
        let dataKey: Uint8Array | null = null;
        if (!plain) {
          if (typeof initial.dataEncryptionKey !== 'string' || !initial.dataEncryptionKey) {
            throw new Error('E2EE Session has no viewer DEK envelope');
          }
          dataKey = openEncryptedDataKeyEnvelopeV1({ envelope: Buffer.from(initial.dataEncryptionKey, 'base64'),
            recipientSecretKeyOrSeed: auth.accountMachineKey });
          if (!dataKey) throw new Error('Account content key could not open the Session DEK');
        }
        const credential = await mintCredential(baseUrl, auth, sessionId, variant === 'e2ee-socket');
        proxy = await startInterruptibleTcpProxy(baseUrl);
        client = connect({ endpoint: proxy.baseUrl, token: credential.credential });
        const controller = await client.sessions.get(sessionId).live();
        artifacts.json('sdk.snapshot.json', () => controller.getSnapshot());
        artifacts.json('runtime.identity.json', () => ({ serverPid: server?.proc.child.pid, daemonPid: daemon.state.pid,
          serverEntrypoint: 'apps/server/sources/main.light.ts', cliEntrypoint: 'apps/cli/src/index.ts',
          sdkEntrypoint: 'packages/sdk/src/index.public.ts', transport: controller.transport, sessionId }));
        expect(controller.transport).toBe(variant === 'e2ee-polling' ? 'polling' : 'socket');
        await waitFor(() => controller.getSnapshot().connection === 'online'
          && controller.getSnapshot().actions.respondToPermission, { timeoutMs: 20_000, context: 'SDK online with active agent' });
        expect(controller.getSnapshot().actions.respondToPermission).toBe(true);
        if (variant === 'e2ee-polling') expect(controller.getSnapshot().actions.abort).toBe(false);

        for (const approved of [true, false]) {
          await controller.send(`SDK fixture ${approved ? 'allow' : 'deny'} file write`);
          await waitFor(() => controller.getSnapshot().pendingRequests.some((request) => request.kind === 'permission'),
            { timeoutMs: 60_000, context: 'fake agent permission is visible in SDK' });
          const pending = controller.getSnapshot().pendingRequests.find((request) => request.kind === 'permission');
          if (!pending) throw new Error('Expected pending permission');
          await controller.respondToPermission({ id: pending.id, approved });
          await waitFor(() => !controller.getSnapshot().pendingRequests.some((request) => request.id === pending.id),
            { timeoutMs: 20_000, context: 'agent reconciles permission decision' });
          expect(controller.getSnapshot().agentState?.completedRequests?.[pending.id]?.status).toBe(approved ? 'approved' : 'denied');
        }

        const commit = async (localId: string, text: string) => {
          // Agent transcript observations must not enqueue extra human prompts.
          const payload = { role: 'agent', content: { type: 'acp', data: { type: 'message', message: text } },
            localId, meta: { happierStreamKey: localId } };
          const content = dataKey ? { t: 'encrypted', c: encryptDataKeyBase64(payload, dataKey) } : { t: 'plain', v: payload };
          const result = await fetchJson<{ message: { id: string; seq: number }; didUpdate?: boolean }>(`${baseUrl}/v2/sessions/${sessionId}/messages`, {
            method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ localId, content, messageRole: 'assistant' }),
          });
          expect(result.status).toBe(200);
          return result.data;
        };
        const sentinelRows = () => controller.getSnapshot().transcript.messageIdsOldestFirst
          .map((id) => controller.getSnapshot().transcript.messagesById[id]!)
          .filter((message) => message.kind === 'agent-text' && message.text.startsWith('SDK-DURABLE-'));
        const revisionLocalId = randomUUID();
        const original = await commit(revisionLocalId, 'SDK-DURABLE-original');
        await waitFor(() => sentinelRows().length === 1, { timeoutMs: 20_000, context: 'durable row before disconnect' });
        // Keep a real agent turn open while its viewer's stream is interrupted.
        await controller.send('SDK fixture reconnect file write');
        await waitFor(() => controller.getSnapshot().pendingRequests.some((request) => request.kind === 'permission'),
          { timeoutMs: 60_000, context: 'agent turn remains open before network drop' });
        const interruptedPermission = controller.getSnapshot().pendingRequests.find((request) => request.kind === 'permission');
        if (!interruptedPermission) throw new Error('Expected in-flight permission before network drop');
        proxy.interrupt();
        await waitFor(() => controller.getSnapshot().connection !== 'online', { timeoutMs: 20_000, context: 'viewer network interrupted' });
        const revised = await commit(revisionLocalId, 'SDK-DURABLE-revised');
        expect(revised.didUpdate).toBe(true);
        expect(revised.message).toMatchObject(original.message);
        const missed = await Promise.all(Array.from({ length: 4 }, (_, index) => commit(randomUUID(), `SDK-DURABLE-missed-${index}`)));
        proxy.resume();
        await waitFor(() => {
          const rows = sentinelRows();
          return controller.getSnapshot().connection === 'online' && rows.length === 5
            && rows.some((message) => message.kind === 'agent-text' && message.text === 'SDK-DURABLE-revised');
        }, { timeoutMs: 30_000, context: 'SDK repairs revised row and catches up without gaps' });
        const expectedSeqs = [original.message.seq, ...missed.map((row) => row.message.seq)].sort((a, b) => a - b);
        expect(sentinelRows().map((row) => row.seq)).toEqual(expectedSeqs);
        expect(new Set(sentinelRows().map((row) => row.id)).size).toBe(5);
        expect(controller.getSnapshot().pendingRequests.some((request) => request.id === interruptedPermission.id)).toBe(true);
        await controller.respondToPermission({ id: interruptedPermission.id, approved: true });
        await waitFor(() => controller.getSnapshot().agentState?.completedRequests?.[interruptedPermission.id]?.status === 'approved',
          { timeoutMs: 20_000, context: 'resumed viewer settles the in-flight permission' });

        if (variant === 'e2ee-polling') {
          // Compare the real two transports on the same persisted rows, including the repaired revision.
          const socketCredential = await mintCredential(baseUrl, auth, sessionId, true);
          const socketClient = connect({ endpoint: baseUrl, token: socketCredential.credential });
          try {
            const reference = await socketClient.sessions.get(sessionId).live({ transport: 'socket' });
            await waitFor(() => {
              if (reference.getSnapshot().connection !== 'online') return false;
              expect(controller.getSnapshot().transcript).toEqual(reference.getSnapshot().transcript);
              return true;
            }, { timeoutMs: 20_000, context: 'socket reference converges to the bearer-only polling transcript' });
          } finally {
            await socketClient.close();
          }
        }

        const revoked = await fetchJson<unknown>(`${baseUrl}${ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1}`, {
          method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenId: credential.tokenId }),
        });
        expect(revoked.status).toBe(200);
        await waitFor(() => ['auth_failed', 'offline'].includes(controller.getSnapshot().connection),
          { timeoutMs: 30_000, context: 'revocation disconnects the live credential' });
        await expect(controller.send('refused after revoke')).rejects.toBeInstanceOf(HappierTransportError);
        await controller.close();
        expect(controller.getSnapshot().connection).toBe('closed');
        console.info('sdk.liveSession.permission runtime', JSON.stringify({ variant, sessionId,
          serverPid: server.proc.child.pid, daemonPid: daemon.state.pid,
          serverSource: 'apps/server/sources/main.light.ts', daemonSource: 'apps/cli/src/index.ts',
          sdkSource: 'packages/sdk/src/index.public.ts', transport: controller.transport, expectedSeqs }));
        passed = true;
      } finally {
        await artifacts.dumpAll(testDir, { onlyIf: !passed });
        await client?.close();
        await proxy?.close();
        await daemon.stop();
      }
    }, 360_000);
  }
});
