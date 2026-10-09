import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { withTempDir } from '@/testkit/fs/tempDir';
import { registerSessionClientRuntimeHandlers } from './registerSessionClientRuntimeHandlers';

const homes: Server[] = [];

// Same decoder-valid Account token vector as the Session runtime-catalog suite.
// Home authentication is the genuine loopback HTTP boundary in this test.
function accountToken(sub: string): string {
  return `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.`;
}

afterEach(async () => {
  resetInMemoryAccountSettingsContextForTests();
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map(home => new Promise<void>((resolve, reject) => {
    home.close(error => error ? reject(error) : resolve());
  })));
});

async function home(settingsVersion: number, rawSettings: Readonly<Record<string, unknown>>) {
  const settingsResponse = AccountSettingsV2GetResponseSchema.parse({
    version: settingsVersion, content: { t: 'plain', v: rawSettings },
  });
  const requests: Array<Readonly<{ method: string | undefined; path: string | undefined;
    authorization: string | undefined; settingsResponse?: typeof settingsResponse }>> = [];
  const server = createServer((request, response) => {
    const isSettingsRead = request.method === 'GET' && request.url === '/v2/account/settings';
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization,
      ...(isSettingsRead ? { settingsResponse } : {}) });
    response.setHeader('Content-Type', 'application/json');
    if (isSettingsRead) {
      response.once('finish', () => server.emit('settings-read'));
      response.end(JSON.stringify(settingsResponse));
    }
    else { response.statusCode = 404; response.end('{}'); }
  });
  const settingsRead = once(server, 'settings-read');
  homes.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing Home loopback address');
  return { url: `http://127.0.0.1:${address.port}`, requests, settingsResponse, settingsRead };
}

describe('Session RPC owner Home Settings custody', () => {
  it.each([false, true])('reads the captured owner Home and its policy for a public plan start without publishing into the focused Account (disabled=%s)', async disabled => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_TTL_MS', '0');
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    vi.stubEnv('HAPPIER_BUILD_FEATURES_ALLOW', 'execution.runs');
    vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
    expect(resolveCliFeatureDecision({ featureId: 'execution.runs', env: process.env }).state).toBe('enabled');
    const ownerCredentials = { token: accountToken('session-owner-account'), encryption: null } as const;
    const focusedCredentials = { token: accountToken('unrelated-focused-account'), encryption: null } as const;
    expect(readAccountIdFromToken(ownerCredentials.token)).toBe('session-owner-account');
    expect(readAccountIdFromToken(focusedCredentials.token)).toBe('unrelated-focused-account');
    const owner = await home(11, { schemaVersion: 6, mcpServersStrictMode: true,
      actionsSettingsV1: { v: 1, actions: { 'execution.run.start': { enabled: !disabled } } } });
    if (owner.settingsResponse.content?.t !== 'plain') throw new Error('Expected plain owner Settings');
    expect(accountSettingsParse(owner.settingsResponse.content.v).actionsSettingsV1.actions['execution.run.start']?.enabled).toBe(!disabled);
    const focused = await home(99, { schemaVersion: 6, mcpServersStrictMode: false });
    await withTempDir('happier-session-owner-home-', async directory => {
      await runWithServerHttpBaseUrl(focused.url, async () => {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ mcpServersStrictMode: false }),
          rawSettings: { mcpServersStrictMode: false }, settingsVersion: 99, loadedAtMs: 1, settingsSecretsReadKeys: [],
          scopeKey: resolveAccountSettingsScopeKey(focusedCredentials),
          acpCatalog: { status: 'ready', revision: 99, record: { v: 1, definitions: [] } } });
        const incumbent = getActiveAccountSettingsSnapshot();
        const incumbentLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        const sessionId = 'foreign-home-session';
        const metadata = createTestMetadata({ path: directory, machineId: 'session-machine' });
        const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
        // These are the Session's durable transcript/network ports, not replacements
        // for its Settings getter, RPC dispatcher, engine registry or catalog services.
        const unexpectedTranscriptWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
        const registration = registerSessionClientRuntimeHandlers({
          rpcHandlerManager: rpc, token: ownerCredentials.token,
          serverId: 'session-owner-home', serverUrl: owner.url,
          readOwnerAccountCredentials: async () => ownerCredentials,
          metadataPath: directory, metadata, sessionId, getSessionMetadata: () => metadata,
          enqueueSessionUserMessage: unexpectedTranscriptWrite,
          enqueueUserTextMessageCommitted: unexpectedTranscriptWrite,
          enqueueAgentMessageCommitted: unexpectedTranscriptWrite,
          enqueueVoiceAgentTranscriptTurnCommitted: unexpectedTranscriptWrite,
          sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
          getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
          persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
        });
        try {
          expect(rpc.hasHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START)).toBe(true);
          const request = ExecutionRunStartRequestSchema.parse({
            intent: 'plan', backendTarget: { kind: 'backend', backendId: 'not-installed-owner-agent',
              configuredBackendId: 'not-installed-owner-agent', sourceKind: 'configured' },
            instructions: 'Read the project and return a plan.', permissionMode: 'read_only',
            retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
          });
          // The transported request supplies no private Action context or Settings.
          // The real handler reads its owner before the later unavailable runtime refuses.
          const result: unknown = await rpc.handleRequest({
            method: `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`, params: request,
            callerAuthority: 'account_automation',
          });
          // Observe the actual boundary response rather than guessing a delay
          // or accepting a missing owner-route witness.
          const expectedErrorCode = disabled ? 'action_disabled' : 'execution_run_failed';
          expect(result).toMatchObject({ ok: false, errorCode: expectedErrorCode });
          await Promise.race([owner.settingsRead, focused.settingsRead]);
          expect({ result, ownerRequests: owner.requests, focusedRequests: focused.requests,
            focusedSnapshotUnchanged: getActiveAccountSettingsSnapshot() === incumbent,
            focusedLifetimeUnchanged: getActiveAccountSettingsSnapshotLifetimeToken() === incumbentLifetime,
          }).toMatchObject({
            result: { ok: false, errorCode: expectedErrorCode },
            ownerRequests: expect.arrayContaining([{ method: 'GET', path: '/v2/account/settings',
              authorization: `Bearer ${ownerCredentials.token}`, settingsResponse: owner.settingsResponse }]),
            focusedRequests: [], focusedSnapshotUnchanged: true, focusedLifetimeUnchanged: true,
          });
          expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(99);
        } finally { await registration.dispose(); }
      });
    });
  });
});
