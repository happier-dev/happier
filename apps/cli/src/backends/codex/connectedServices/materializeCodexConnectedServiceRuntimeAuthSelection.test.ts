import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountSettingsSchema, buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { Credentials } from '@/persistence';
import { removeTempDir } from '@/testkit/fs/tempDir';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createSessionRecordFixture, createSessionListResponseFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import * as appServerControl from '../appServer/control/withCodexAppServerControlClient';
import { materializeCodexConnectedServiceRuntimeAuthSelection } from './materializeCodexConnectedServiceRuntimeAuthSelection';
import { resolveConnectedServiceHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';

const { io } = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('socket.io-client')>(),
  io,
}));

describe('materializeCodexConnectedServiceRuntimeAuthSelection', () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  beforeEach(() => { io.mockReset(); });
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.restoreAllMocks();
  });

  it('materializes direct live runtime apply through session RPC without probing a control app-server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-switch-target-'));
    cleanup.push(() => removeTempDir(root));
    const activeServerDir = join(root, 'server');
    const oldHome = join(resolveConnectedServiceHomeDir({ activeServerDir, serviceId: 'openai-codex', profileId: 'old', agentId: 'codex' }), 'codex-home');
    await mkdir(join(oldHome, 'sessions'), { recursive: true });
    await writeFile(join(oldHome, 'sessions', 'private.jsonl'), 'private-history\n');
    const remoteSession = createSessionRecordFixture({ id: 'sess_1', encryptionMode: 'plain' });
    const relay = Fastify();
    relay.get('/v2/sessions/sess_1', async (request) => {
      expect(request.headers.authorization).toBe('Bearer machine-token');
      return { session: remoteSession };
    });
    relay.get('/v2/sessions', async () => createSessionListResponseFixture([remoteSession]));
    relay.get('/v2/sessions/archived', async () => createSessionListResponseFixture([]));
    await relay.ready();
    cleanup.push(() => relay.close());
    cleanup.push(installAxiosFastifyAdapter({ app: relay, origin: new URL(resolveServerHttpBaseUrl()).origin }));
    const wireRequests: unknown[] = [];
    io.mockImplementation(() => createApiSessionSocketStub({
      emit: (event, args) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        const [payload, acknowledge] = args as [unknown, (response: unknown) => void];
        wireRequests.push(payload);
        acknowledge({ ok: true, result: {
          ok: true,
          appliedVia: 'direct_live_hot_auth',
          verification: { activeAccountId: 'acct_target' },
        } });
      },
    }));
    const controlProbe = vi.spyOn(appServerControl, 'withCodexAppServerControlClient');

    const credential = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'target',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct_target',
        providerEmail: 'target@example.test',
      },
    });
    const baseSelection = {
      serviceId: 'openai-codex',
      binding: { source: 'connected', selection: 'profile', profileId: 'target' },
      profileId: 'target',
      credentialRevision: null,
      record: credential,
    } as const;

    const materialized = await materializeCodexConnectedServiceRuntimeAuthSelection({
      credentials: { token: 'machine-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } } satisfies Credentials,
      api: {} as never,
      activeServerDir,
      processEnv: { HOME: root, CODEX_HOME: join(root, 'native') },
      accountSettings: AccountSettingsSchema.parse({ connectedServicesProviderStateSharingSettingsV1: { byAgentId: { codex: { stateMode: 'isolated' } } } }),
      input: {
        mode: 'apply',
        tracked: {
          startedBy: 'daemon',
          happySessionId: 'sess_1',
          pid: 123,
          happySessionMetadataFromLocalWebhook: createTestMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: {
            home: 'connectedService', homePath: oldHome, connectedServiceId: 'openai-codex', connectedServiceProfileId: 'old',
          } } }),
          spawnOptions: {
            directory: '/tmp/project',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          },
        },
        sessionId: 'sess_1',
        agentId: 'codex',
        serviceId: 'openai-codex',
        previous: null,
        next: { source: 'connected', selection: 'profile', serviceId: 'openai-codex', profileId: 'target', groupId: null },
        previousBindings: { v: 1, bindingsByServiceId: {} },
        normalizedBindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'target' },
          },
        },
        applyReason: 'same_provider_account_exhausted',
      },
      baseSelection,
    });

    expect(controlProbe).not.toHaveBeenCalled();
    expect(materialized).toMatchObject({
      serviceId: 'openai-codex',
      applyReason: 'same_provider_account_exhausted',
    });
    const targetRoot = resolveConnectedServiceHomeDir({ activeServerDir, serviceId: 'openai-codex', profileId: 'target', agentId: 'codex' });
    expect(materialized).toMatchObject({ targetMaterializedRoot: targetRoot,
      targetMaterializedEnv: { CODEX_HOME: join(targetRoot, 'codex-home') } });
    await expect(readFile(join(targetRoot, 'codex-home', 'sessions', 'private.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(oldHome, 'sessions', 'private.jsonl'), 'utf8')).resolves.toBe('private-history\n');

    const apply = (materialized as Readonly<{
      applyConnectedServiceAuthGeneration?: (request: unknown) => Promise<unknown>;
    }>).applyConnectedServiceAuthGeneration;
    await expect(apply?.({ serviceId: 'openai-codex', reason: 'same_provider_account_exhausted' }))
      .resolves
      .toEqual({
        ok: true,
        appliedVia: 'direct_live_hot_auth',
        verification: { activeAccountId: 'acct_target' },
      });
    expect(wireRequests).toEqual([expect.objectContaining({
      timeoutMs: 60_000,
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION}`,
      params: { serviceId: 'openai-codex', reason: 'same_provider_account_exhausted' },
    })]);
  });
});
