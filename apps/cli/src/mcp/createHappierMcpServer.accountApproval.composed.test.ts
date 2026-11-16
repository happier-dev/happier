import fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { expect, it, onTestFailed } from 'vitest';
import { accountSettingsParse, FeaturesResponseSchema } from '@happier-dev/protocol';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { createRetainedAccountExecutionRuntime } from '@/plugins/runtime/accountExecutionRuntime';
// Collect the real lazy runtime before the test clock; source transformation is not Action work.
import '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import '@/daemon/connectedServices/purposeBindings/createRequesterConnectedAccountPurposeBindingRuntime';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { prepareAccountSettingsV2Content } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { StoredCredentials } from '@/persistence';
import { createHappierMcpServer } from './createHappierMcpServer';

it.each(['plain', 'e2ee'] as const)('indexes a current-process Account Action approval under its initiating Session (%s)', async mode => {
  let phase = 'authored_release';
  onTestFailed(() => { console.info('approval regression phase:', phase); });
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'account-mcp-approval-'));
  const app = fastify();
  const accountId = 'account-approval-owner';
  const sessionId = 'account-approval-session';
  const serverId = 'account-approval-home';
  const serverUrl = 'http://account-mcp-approval.test';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  const keys = mode === 'e2ee' ? nacl.box.keyPair() : null;
  const credentials: StoredCredentials = { token, credentialProvenance: 'stored_session',
    encryption: keys ? { type: 'dataKey', machineKey: keys.secretKey, publicKey: keys.publicKey } : null };
  if (mode === 'plain') registerAccountHomeHttp(app, { accountId, serverId });
  else {
    app.get('/v1/account/encryption', async () => ({ mode, updatedAt: 1 }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode, version: 1,
      signingKeyFingerprint: 'fixture-signing', contentKeyFingerprint: 'fixture-content', updatedAt: 1 }));
    app.get('/v1/account/profile', async () => ({ id: accountId }));
    app.get('/v2/account/settings', async () => ({ content: prepareAccountSettingsV2Content({ credentials, raw: {},
      envelopeKind: 'encrypted', randomBytes: nacl.randomBytes }), version: 1 }));
  }
  const authored = await registerAuthoredAccountActionRelease(app, accountId, { encryptionMode: mode });
  phase = 'release_registered';
  let observeApproval = false;
  let onCreated!: (id: string) => void;
  const created = new Promise<string>(resolve => { onCreated = resolve; });
  app.addHook('onResponse', async request => {
    if (observeApproval && request.method === 'POST' && request.url === '/v1/artifacts') {
      const body = request.body;
      if (body && typeof body === 'object' && 'id' in body && typeof body.id === 'string') onCreated(body.id);
    }
  });
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin: serverUrl });
  const abort = new AbortController();
  const retained = createRetainedAccountExecutionRuntime(() => ({ happyHomeDir,
    accountExecution: { credentials, serverUrl, serverId, isCurrent: () => !abort.signal.aborted } }));
  let runtime: ReturnType<typeof createHappierMcpServer> | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    await runWithServerHttpBaseUrl(serverUrl, () => authored.publishArtifacts(credentials));
    phase = 'published';
    const accountRuntime = await runWithServerHttpBaseUrl(serverUrl, () => retained.read());
    phase = 'runtime_read';
    const client = Object.assign(createMutableApiSessionClientFixture({ sessionId, metadata: createTestMetadata(), overrides: {
      getServerBinding: () => ({ serverId, serverUrl }),
      getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }),
    } }), { getActiveTurnAdmissionWitness: () => ({ turnId: 'account-approval-turn', inputId: 'account-approval-input',
      userMessageSeq: 1, userMessageSeqs: [1], signal: abort.signal,
      agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 2, turnDepth: 3 },
    }) });
    runtime = createHappierMcpServer(client, { credentials, accountSettings: accountSettingsParse({}),
      toolExecutionSignal: abort.signal, pluginRuntimeRegistryLease: { registry: accountRuntime.registry,
        source: 'ephemeral', durableRevision: -1, release: async () => {}, accountRuntime: retained } });
    observeApproval = true;
    phase = 'tool_pending';
    pending = runWithServerHttpBaseUrl(serverUrl, () => runtime!.executeTool({ toolName: 'action_execute', args: {
      actionId: `${authored.pluginId}/actions/write`, input: { key: 'own-value', value: 'pending-value' },
    } }));
    const artifactId = await Promise.race([created, pending.then(result => { throw new Error(JSON.stringify(result)); })]);
    phase = 'assert_origin';
    await runWithServerHttpBaseUrl(serverUrl, async () => {
      const request = await createCliApprovalsArtifactStore({ credentials }).targetActionApprovalsGet({ artifactId });
      expect(request).toMatchObject({ status: 'open', approvalInputCustody: 'live_only', executionOriginV1: {
        serverId, accountId, sessionId, caller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 },
      } });
      const artifact = await createCredentialedAccountArtifactStore(credentials).read(artifactId);
      expect(artifact?.header).toMatchObject({ sessionId, serverId, approvalStatus: 'open' });
    });
  } finally {
    const beforeCleanup = phase;
    phase = `cleanup_after_${beforeCleanup}`;
    abort.abort();
    await pending?.catch(() => {});
    await runtime?.mcp.close();
    await retained.dispose();
    restore();
    await app.close();
    resetActiveAccountSettingsSnapshotForTests();
    await rm(happyHomeDir, { recursive: true, force: true });
  }
});
