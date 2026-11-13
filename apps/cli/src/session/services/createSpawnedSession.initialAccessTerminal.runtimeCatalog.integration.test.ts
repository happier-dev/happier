import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  deriveSessionCreationTagV1,
  SessionCreationKeyV1Schema,
  type SessionInitialAccessDraftV1,
} from '@happier-dev/protocol';

import { ApiClient } from '@/api/api';
import { initializeBackendRunSession } from '@/agent/runtime/initializeBackendRunSession';
import { configuration, reloadConfiguration } from '@/configuration';
import { resolveDaemonSpawnSessionByNonce, spawnDaemonSession } from '@/daemon/controlClient';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createOnDaemonSessionStartupFailure } from '@/daemon/sessions/onHappySessionWebhook';
import { waitForSessionWebhook } from '@/daemon/spawn/waitForSessionWebhook';
import type { TrackedSession } from '@/daemon/types';
import { clearDaemonStateForTestTeardown, writeDaemonState } from '@/persistence';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { HAPPIER_SESSION_STARTUP_SPAWN_NONCE_ENV_KEY } from '@/session/runtime/control/sessionControlEnvironment';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

// The Home's typed no-effect refusal when Session sharing is off. It must
// reach the Action as that reason, never as an update requirement.
const refusalCode = 'session_access_sharing_unavailable' as const;
const refusalDetail = { kind: 'session_creation_access_refused', code: refusalCode } as const;
const initialAccess: SessionInitialAccessDraftV1 = {
  grants: [{ subject: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view', canApprovePermissions: false }],
};

describe('initial access terminal refusal through API, daemon HTTP, waiter and Action', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    reloadConfiguration();
  });

  it.each(['spawn-response', 'nonce-resolution', 'sharing-disabled-preflight'] as const)(
    'returns the typed no-effect sharing refusal via %s without creating or attaching a Session',
    async (mode) => {
      const homeDir = await createTempDir('happier-initial-access-terminal-');
      const requests: Array<{ method: string | undefined; url: string | undefined; body: unknown }> = [];
      // The Home HTTP peer is the external boundary. All CLI parsing, startup,
      // daemon transport/correlation and Action adaptation run their real code.
      const server = http.createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const rawBody = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: request.method, url: request.url, body: rawBody ? JSON.parse(rawBody) : null });
        response.setHeader('content-type', 'application/json');
        if (request.url === '/v1/features' || request.url === '/v1/features/authenticated') {
          response.end(JSON.stringify({
            features: {
              sessions: { enabled: true },
              sharing: { session: { enabled: mode !== 'sharing-disabled-preflight' } },
            },
            capabilities: {
              accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: 2,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
              },
              encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' },
            },
          }));
        } else if (request.url === '/v1/account/profile') {
          response.end(JSON.stringify({ id: 'owner' }));
        } else if (request.url === '/v1/account/encryption/currentness') {
          response.end(JSON.stringify({
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
          }));
        } else if (request.url === '/v2/sessions/lookup-by-tags') {
          response.end(JSON.stringify({ sessions: [] }));
        } else if (request.url === '/v1/sessions' && request.method === 'POST') {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: refusalCode }));
        } else {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'unexpected_test_request' }));
        }
      });
      const tracked = new Map<SessionTrackingKey, TrackedSession>();
      const awaiters = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
      const resolvers = new Map<SessionTrackingKey, (result: SpawnSessionResult) => void>();
      const timeouts = new Map<SessionTrackingKey, NodeJS.Timeout>();
      let startupError: unknown;
      let startup: Promise<void> | undefined;
      let observedNonce = '';
      let spawnCount = 0;
      const daemon = createDaemonControlApp({
        machineId: 'machine-1',
        controlToken: 'test-control-token',
        getChildren: () => [...tracked.values()],
        stopSession: async () => ({ status: 'not_found' }),
        requestShutdown: () => {},
        onHappySessionWebhook: () => { throw new Error('Refused creation must not report a Session'); },
        onSessionStartupFailure: createOnDaemonSessionStartupFailure({ trackedSessionsByKey: tracked, spawnAwaiterByKey: awaiters }),
        spawnSession: async (options) => {
          spawnCount += 1;
          observedNonce = options.spawnNonce ?? '';
          const pid = process.pid;
          tracked.set(legacyPidSessionTrackingKey(pid), { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: `PID-${pid}`, spawnOptions: options });
          const pending = waitForSessionWebhook({
            trackingKey: legacyPidSessionTrackingKey(pid), pid, spawnAwaiterByKey: awaiters, trackedSessionsByKey: tracked,
            spawnResultResolverByKey: resolvers, spawnWebhookTimeoutByKey: timeouts,
            timeoutMs: 2_000, timeoutErrorMessage: 'Terminal creation refusal was lost',
          });
          // Substitute only process creation: run the child bootstrap in this
          // process, using the actual admitted nonce and real API client.
          vi.stubEnv(HAPPIER_SESSION_STARTUP_SPAWN_NONCE_ENV_KEY, observedNonce);
          startup = (async () => {
            try {
              await initializeBackendRunSession({
                api: await ApiClient.create({ token: 'test-token', encryption: null }),
                sessionTag: options.sessionCreationTag ?? 'initial-access-terminal',
                initialAccess: options.initialAccess,
                metadata: {
                  path: homeDir, host: 'test-host', homeDir, happyHomeDir: homeDir,
                  happyLibDir: homeDir, happyToolsDir: homeDir, startedBy: 'daemon',
                },
                state: { controlledByUser: false },
                uiLogPrefix: '[initial-access-terminal-test]',
                startupMetadataOverrides: { permissionModeOverride: { mode: 'default', updatedAt: 1 } },
              });
            } catch (error) {
              startupError = error;
            }
          })();
          return pending;
        },
      });

      try {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected a TCP Home endpoint');
        vi.stubEnv('HAPPIER_HOME_DIR', homeDir);
        vi.stubEnv('HAPPIER_SERVER_URL', `http://127.0.0.1:${address.port}`);
        vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', `http://127.0.0.1:${address.port}`);
        reloadConfiguration();
        await daemon.listen({ host: '127.0.0.1', port: 0 });
        const daemonAddress = daemon.server.address();
        if (!daemonAddress || typeof daemonAddress === 'string') throw new Error('Expected a TCP daemon endpoint');
        writeDaemonState({
          pid: process.pid, httpPort: daemonAddress.port, startedAt: Date.now(),
          startedWithCliVersion: 'test', controlToken: 'test-control-token',
        });
        const deps = createCliActionDeps({
          token: 'test-token', credentials: { token: 'test-token', encryption: null },
          sessionId: 'parent', mode: 'plain', ctx: null,
          sessionSpawnDirectTargetTransport: {
            machineId: 'machine-1',
            prepare: async () => ({ ok: true, directory: homeDir, directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
            spawnedSession: {
              spawn: async (request) => {
                const result = await spawnDaemonSession(request);
                // Emulate an accepted response whose terminal body was lost;
                // the existing HTTP nonce resolver must recover that same result.
                return mode === 'nonce-resolution'
                  ? { success: true, status: 'pending', spawnNonce: request.spawnNonce }
                  : result;
              },
              resolveSpawnSessionByNonce: resolveDaemonSpawnSessionByNonce,
            },
          },
        });
        const result = await deps.sessionSpawnNew({
          creationKey: SessionCreationKeyV1Schema.parse('initial-access-terminal'),
          sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'initial-access-terminal' }),
          executionTarget: { serverId: configuration.activeServerId, machineId: 'machine-1' },
          directory: { kind: 'path', path: homeDir },
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          connectedServices: { v: 2, bindingsByServiceId: {} },
          actionCaller: { kind: 'host' },
          initialAccess,
          signal: AbortSignal.timeout(5_000),
        });
        await startup;
        expect(startupError).toMatchObject({ code: refusalCode, retryable: false });
        expect(result).toEqual({ type: 'error', code: refusalCode, retryable: false });
        expect(await resolveDaemonSpawnSessionByNonce(observedNonce)).toMatchObject({
          status: 'error', errorCode: 'SPAWN_VALIDATION_FAILED', errorDetail: refusalDetail,
        });
        expect(spawnCount).toBe(1);
        expect(awaiters.size).toBe(0);
        expect(resolvers.size).toBe(0);
        expect(timeouts.size).toBe(0);
        const creates = requests.filter((request) => request.url === '/v1/sessions');
        expect(creates).toHaveLength(mode === 'sharing-disabled-preflight' ? 0 : 1);
        if (creates.length) expect(creates[0]?.body).toMatchObject({ initialAccess });
        expect(requests.filter((request) => request.url?.includes('/access-grants/'))).toEqual([]);
      } finally {
        for (const timeout of timeouts.values()) clearTimeout(timeout);
        await startup;
        await daemon.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await clearDaemonStateForTestTeardown();
        await removeTempDir(homeDir);
      }
    },
  );
});
