import { onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createRequesterCurrentnessSocketHarness, type RequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { prepareRequesterSessionBootstrap, type AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import type { StoredCredentials } from '@/persistence';
import type { MachineInstallationIdentityV1 } from '@happier-dev/protocol';

export type ProjectSessionRuntimeFixture = Readonly<{
  directory: string;
  readonly bootstrap: AdmittedRequesterSessionBootstrap;
  createBootstrap(): Promise<AdmittedRequesterSessionBootstrap>;
  installation: MachineInstallationIdentityV1;
  channel: RequesterCurrentnessSocketHarness;
  isHomeCurrent(): boolean;
  retire(): void;
}>;

/** Real ordinary Session admission; only Home endpoints are substituted. */
export async function createProjectSessionRuntimeFixture(options: Readonly<{
  serverId?: string; serverUrl?: string; accountSettings?: Readonly<Record<string, unknown>>; boundSessionId?: string;
  credentials?: StoredCredentials;
  homeServerIdentityId?: string;
  machineAccess?: Readonly<{ custodianAccountId: string; role: 'use' | 'manage' }>;
}> = {}): Promise<ProjectSessionRuntimeFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'project-session-runtime-'));
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL']);
  env.patch({ HAPPIER_HOME_DIR: directory,
    ...(options.serverId ? { HAPPIER_ACTIVE_SERVER_ID: options.serverId } : {}),
    ...(options.serverUrl ? { HAPPIER_SERVER_URL: options.serverUrl } : {}) });
  reloadConfiguration();
  onTestFinished(async () => { env.restore(); reloadConfiguration(); await rm(directory, { recursive: true, force: true }); });
  const installation = await readOrCreateInstallationIdentity();
  const channel = await createRequesterCurrentnessSocketHarness();
  onTestFinished(() => channel.close());
  onTestFinished(installAxiosRequestMethodAdapter());
  let current = true;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/profile') return Response.json({ id: 'requester' });
    throw new Error(`Unexpected Home fetch: ${path}`);
  }));
  vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
    if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'requester' } };
    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: options.accountSettings ?? {} }, version: 0 } };
    const sessionId = new URL(url).pathname.match(/^\/v2\/sessions\/([^/]+)$/u)?.[1];
    if (sessionId) return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId,
      encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine' }), dataEncryptionKey: null, share: null }) } };
    if (url.endsWith('/v1/machines/machine/access')) return { status: current ? 200 : 403, data: current
      ? MachineAccessGrantsListResponseV1Schema.parse({ machineId: 'machine', custodian: { accountId: options.machineAccess?.custodianAccountId ?? 'requester', displayName: 'Requester' },
        access: { custodian: { accountId: options.machineAccess?.custodianAccountId ?? 'requester', displayName: 'Requester' }, role: options.machineAccess?.role ?? 'manage', resourceMode: 'plain', accessState: 'ready' },
        canManage: (options.machineAccess?.role ?? 'manage') === 'manage', grants: [], ownDirectGrant: false, ownAccessSources: [] })
      : { kind: 'refused', code: 'access_denied' } };
    if (url.endsWith('/v1/machines/machine')) return { status: 200, data: { machine: {
      id: 'machine', installationId: installation.installationId, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      access: { custodian: { accountId: options.machineAccess?.custodianAccountId ?? 'requester', displayName: 'Requester' },
        role: options.machineAccess?.role ?? 'manage', resourceMode: 'plain', accessState: 'ready' },
      metadataVersion: 1, daemonStateVersion: 0, daemonState: null,
      metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', homeDir: '/home/user',
        happyCliVersion: 'test', happyHomeDir: '/home/user/.happier' }),
    } } };
    throw new Error(`Unexpected Home read: ${new URL(url).pathname}`);
  });
  let currentBootstrap: Awaited<ReturnType<typeof prepareRequesterSessionBootstrap>> = null;
  const createBootstrap = async () => {
    const prepared = await prepareRequesterSessionBootstrap({ credentials: options.credentials ?? {
      token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url')}.signature`, encryption: null },
      attribution: { serverId: options.serverId ?? 'session-home', accountId: 'requester', machineId: 'machine', installationId: installation.installationId },
      boundary: { serverId: options.serverId ?? 'session-home', serverHttpBaseUrl: options.serverUrl ?? 'https://session-home.test', happyHomeDir: directory },
      ...(options.homeServerIdentityId ? { homeServerIdentityId: options.homeServerIdentityId } : {}),
      ...(options.boundSessionId ? { boundSessionId: options.boundSessionId } : {}),
      verifyMachineAdmissionCurrent: async () => current });
    if (!prepared) throw new Error('Session admission failed');
    onTestFinished(prepared.cleanupOnFailure);
    // Cold synchronous host setup shares this test's event loop with Home.
    // Finish both ends of the real upgrade before that work can exhaust Engine.IO's upgrade window.
    await channel.settleTransport();
    currentBootstrap = prepared;
    return prepared.admitted;
  };
  await createBootstrap();
  return { directory, get bootstrap() {
    if (!currentBootstrap) throw new Error('Session admission unavailable');
    return currentBootstrap.admitted;
  }, createBootstrap, installation, channel, isHomeCurrent: () => current, retire: () => { current = false; } };
}
