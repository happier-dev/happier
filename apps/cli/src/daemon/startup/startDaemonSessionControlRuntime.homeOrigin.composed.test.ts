import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ApiMachineClient } from '@/api/apiMachine';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { readOrCreateInstallationIdentity } from '../identity/store';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';

it('moves retained installed Account Follow discovery and Run routes to a replacement Home listener', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daemon-follow-home-origin-'));
  const accountId = 'follow-origin-account';
  const serverId = 'follow-origin-home';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.fixture`;
  const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
  const paths: string[][] = [[], []];
  // Only HTTP and the local control listener are external boundaries. Machine,
  // installed Account resolution, startup, discovery and route reads stay real.
  const servers = paths.map(requests => createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    requests.push(path);
    response.setHeader('Content-Type', 'application/json');
    const body = path.endsWith('/profile') ? { id: accountId }
      : path.endsWith('/currentness') ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
      : path === '/v2/account/session-follows' ? { follows: [{ source: { kind: 'workflow_run', runId: 'followed-run' },
        following: true, persistent: true, policy: { preset: 'important' } }] }
      : path === '/v2/account/session-follow-rules' ? { rules: [] }
      : path === '/v2/follows/sources/run-occurrence-routes' ? { ok: false, v: 1, error: 'source_unavailable' }
      : {};
    response.end(JSON.stringify(body));
  }));
  const releases: (() => void)[] = [];
  let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | undefined;
  let machine: ApiMachineClient | undefined;
  const close = async (server: typeof servers[number]) => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  try {
    for (const server of servers) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origins = servers.map(server => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test Home listener');
      return `http://127.0.0.1:${address.port}`;
    });
    const first = origins[0]!;
    const next = origins[1]!;
    releases.push(publishServerHttpRuntimeOrigin(first, 'iroh', undefined, serverId));
    host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId, serverHttpBaseUrl: first, machineId: 'machine', custodianAccountId: accountId, credentials,
      connectedServicesMaterializationBaseDir: join(directory, 'materialized'), registry: new ConnectedServiceRuntimeRegistry(),
      trackedSessions: new Map(), getRequester: () => null, getApiMachineForSessions: () => machine ?? null,
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate', beforeStartup: async () => {
        await writeStoredCredentialsForServerId(serverId, credentials);
        await readOrCreateInstallationIdentity();
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
          loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
        machine = new ApiMachineClient(token, { id: 'machine', encryptionMode: 'plain', metadata: null, metadataVersion: 0,
          daemonState: null, daemonStateVersion: 0 });
      } });
    expect(await machine!.resolveInstalledAccountObservationRuntime(new AbortController().signal), JSON.stringify(paths)).toMatchObject({ accountId, serverId });
    const discover = () => host!.runtime.dispatchSessionFollowOccurrence({ accountFollowSourcesChanged: { configurationChanged: true } });
    await discover();
    expect(paths[0], JSON.stringify(paths)).toContain('/v2/account/session-follows');
    expect(paths[0]).toContain('/v2/follows/sources/run-occurrence-routes');
    releases.push(publishServerHttpRuntimeOrigin(next, 'iroh', undefined, serverId));
    releases[0]!();
    await close(servers[0]!);
    // A finite operation keeps its origin, but the next retained-owner dispatch
    // must resolve the new installed Account endpoint with the same Machine.
    const failure = await discover().then(() => null, (error: unknown) =>
      error && typeof error === 'object' && 'code' in error ? error.code : 'unexpected_failure');
    expect(failure).toBeNull();
    expect(paths[1]).toContain('/v2/account/session-follows');
    expect(paths[1]).toContain('/v2/follows/sources/run-occurrence-routes');
  } finally {
    await host?.dispose();
    await machine?.shutdown();
    for (const release of releases) release();
    resetActiveAccountSettingsSnapshotForTests();
    await Promise.all(servers.map(close));
    await rm(directory, { recursive: true, force: true });
  }
});
