import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServices/connectedServiceChildEnvironment';
import { createRequesterSessionRuntimeContextResolver } from '../sessionEncryption/requesterSessionCredentials';
import { legacyPidSessionTrackingKey, type TrackedSessionMap } from '../sessions/sessionTrackingKey';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';

it('returns session control before retained Session recovery needs the requester factory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-startup-requester-readiness-'));
  const trackingKey = legacyPidSessionTrackingKey(7811);
  const trackedSessions: TrackedSessionMap = new Map([[trackingKey, {
    trackingKey, pid: 7811, startedBy: 'daemon', happySessionId: 'retained-session', reattachedFromDiskMarker: true,
    spawnOptions: {
      directory,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      connectedServiceMaterializationIdentityV1: { v: 1, id: 'csm_retained', createdAt: 1 },
      connectedServices: { v: 1, bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'primary' },
      } },
      environmentVariables: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
        { kind: 'profile', serviceId: 'openai-codex', profileId: 'primary', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' },
      ]) },
    },
  }]]);
  let ready!: () => void;
  const readiness = new Promise<void>(resolve => { ready = resolve; });
  let waiting!: () => void;
  const readinessRequested = new Promise<void>(resolve => { waiting = resolve; });
  let factoryReady = false;
  const factory = async () => null;
  const resolver = createRequesterSessionRuntimeContextResolver({
    trackedSessions,
    getCreateRuntime: () => factoryReady ? factory : null,
    whenRuntimeCreatable: () => { waiting(); return readiness; },
    // No recovered custody exists in this fixture; no credential files are opened.
    recoverBootstrap: async () => null,
  });
  const starting = createRequesterSessionControlRuntimeFixture({
    happyHomeDir: join(directory, 'home'), activeServerDir: join(directory, 'home', 'servers', 'home'),
    serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', machineId: 'machine', custodianAccountId: 'owner',
    credentials: { token: 'fixture', encryption: null }, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
    registry: new ConnectedServiceRuntimeRegistry(), trackedSessions, getRequester: () => null,
    resolveRequesterSessionRuntimeContext: resolver, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
  });
  try {
    expect(await Promise.race([
      starting.then(() => 'started'),
      readinessRequested.then(() => 'requester-wait-before-startup-returned'),
    ])).toBe('started');
    factoryReady = true;
    ready();
    const fixture = await starting;
    // Mirrors startDaemon: install factory, then recover retained targets.
    await fixture.runtime.initializeReattachedSessions();
  } finally {
    factoryReady = true;
    ready();
    const fixture = await starting;
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
