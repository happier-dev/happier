import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { AccountSettingsSchema, FeaturesResponseSchema, SavedSecretResourceMaterialsResponseV1Schema,
  sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { verifyMachineInstallationProof, type RequesterSessionCurrentnessPurposeV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { configuration } from '@/configuration';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { commitActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createRequesterSessionCredentialCustody, resolveRequesterSessionBootstrap } from '../sessionEncryption/requesterSessionCredentials';
import { withRealForegroundAdmissionFixture } from './foregroundAdmission.testkit';
import { createExternalConnectedAccountForegroundFixture, createForegroundPurposeOwnerFixture } from './prepareForegroundAdmission.connectedServices.testkit';
import type { PrepareForegroundAgentRuntimeAdmissionDependencies } from './prepareForegroundAdmission';
import { createRequesterSessionRuntimeContext } from '../sessionEncryption/createRequesterSessionRuntimeContext';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveQualifiedConnectedAccountAtomicV4Negotiation } from '@/api/client/qualifiedConnectedAccountApi';
import { promoteForegroundDaemonServiceAuthority } from './promoteForegroundDaemonServiceAuthority';
import { readSessionMarkerForPid, writeSessionMarker } from '../sessionRegistry';
import type { TrackedSession } from '../types';
import { resolveAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import { ProfileRecordV1Schema, sealProfileRecordContentV1 } from '@happier-dev/protocol/profiles/profileRecordV1';

describe('foreground requester Account admission through protected custody', () => {
  it('claims Bob Profile material without publishing Bob as Alice, and refuses lost admission before claiming material', async () => {
    const service = { pluginId: 'acme.credentials', localId: 'native' } as const;
    const alicePurpose = createExternalConnectedAccountForegroundFixture({ service, materializationKinds: ['files'],
      launch: { stateSharingDescriptor: { providerSupportStatus: 'supported',
        config: { supported: true, modes: ['copied'], entries: [{ path: 'config.toml', mode: 'force_copied' }] },
        state: { supported: true, modes: ['isolated'], entries: [], symlinkUnavailableDegradePolicy: 'degrade_to_isolated' },
        authIsolation: { mode: 'materialized_home', secretEntries: ['auth.json'] },
        nativeHome: { environmentKey: 'ACME_NATIVE_HOME', defaultRelativePath: '.acme-native-home' } } },
      materializeAccount: async () => { throw new Error('Bob foreground must never open Alice native Account'); } });
    let bobFile = '';
    const bobPurpose = createForegroundPurposeOwnerFixture({ consumer: alicePurpose.purpose.consumer,
      service, accountId: 'bob-connected-account', materializeAccount: async ({ account, request }) => {
        expect(account.accountId).toBe('bob-connected-account');
        expect(request).toEqual({ kind: 'files', fileIds: ['auth.json'] });
        return { kind: 'files', files: { 'auth.json': await readFile(bobFile) } };
      } });
    await withRealForegroundAdmissionFixture({ plugins: alicePurpose.plugins,
      runtimeOptions: { connectedAccounts: alicePurpose.owner } }, async fixture => {
      const admittedService = await fixture.runtime.registry.connectedAccountContributions?.resolve(service);
      expect(admittedService?.ref).toEqual(service);
      expect(admittedService?.isCurrent()).toBe(true);
      const agentRequest = alicePurpose.requestFor(fixture.runtime.registry);
      expect(resolveAgentCliLaunchSpec(agentRequest.agentId, {
        catalogSnapshot: fixture.runtime.registry.contributes,
      })).not.toBeNull();
      bobFile = join(fixture.directory, 'bob-native-auth');
      await writeFile(bobFile, new Uint8Array([0, 255, 17, 99]));
      const aliceNativeHome = join(fixture.directory, 'alice-native-home');
      await mkdir(aliceNativeHome);
      await writeFile(join(aliceNativeHome, 'config.toml'), 'alice-private-config');
      const app = fastify();
      const origin = new URL(configuration.serverUrl).origin;
      const credentials = { token: 'bob-foreground-private', encryption: null } as const;
      const attribution = { serverId: configuration.activeServerId, accountId: 'bob', machineId: 'machine-1', installationId: 'install-1' };
      const sessionId = 'bob-foreground-session';
      const reference = 'happier:shared-secret:v1:bob-profile-secret';
      let granted = true;
      const keyPair = tweetnacl.sign.keyPair();
      const reads: Array<{ path: string; bearer?: string }> = [];
      const settings = AccountSettingsSchema.parse({});
      const profile = ProfileRecordV1Schema.parse({ v: 1, id: 'bob-profile', enabled: true, promptStack: [],
        secretBindings: { BOB_PROFILE_SECRET: reference }, definition: { kind: 'legacy', profile: {
          id: 'bob-profile', name: 'Bob Profile',
          envVarRequirements: [{ name: 'BOB_PROFILE_SECRET', kind: 'secret', required: true }], environmentVariables: [],
          defaultPermissionModeByTargetKey: {}, compatibilityByTargetKey: {}, isBuiltIn: false,
          createdAt: 1, updatedAt: 1, version: '1.0.0',
        } } });
      const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} });
      app.addHook('onRequest', async request => { reads.push({ path: request.url, bearer: request.headers.authorization }); });
      app.get('/v1/features', async () => features);
      app.get('/v1/features/authenticated', async () => features);
      app.get('/v1/account/profile', async () => ({ id: 'bob' }));
      app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
      app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, updatedAt: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null }));
      app.get('/v2/account/settings', async () => ({ version: 1, content: { t: 'plain', v: settings } }));
      app.get('/v1/artifacts', async () => []);
      app.get('/v1/account/entity-rows/profiles/reference-guard', async () => ({ status: 'ready', revision: 1 }));
      app.get('/v1/account/entity-rows/profiles/transfer', async () => ({ status: 'absent' }));
      app.get('/v1/account/entity-rows/profiles', async () => ({ status: 'listed', rows: [{ id: profile.id, revision: 1,
        content: sealProfileRecordContentV1({ mode: 'plain', material: null, record: profile }) }], nextCursor: null,
        complete: true, diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' } }));
      app.get('/v1/machines/machine-1/access', async (_request, reply) => granted ? { machineId: 'machine-1',
        custodian: { accountId: 'alice', displayName: 'Alice' }, access: { custodian: { accountId: 'alice', displayName: 'Alice' },
          role: 'use', resourceMode: 'plain', accessState: 'ready' }, canManage: false, grants: [], ownDirectGrant: true, ownAccessSources: [] }
        : reply.code(403).send({ kind: 'refused', code: 'access_denied' }));
      app.post('/v1/machines/machine-1/admission/verify', async (request, reply) => {
        const body = request.body as { context: SocketRpcMachineAdmissionContextV1; method?: string;
          purpose?: RequesterSessionCurrentnessPurposeV1;
          proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
        const valid = verifyMachineInstallationProof({ publicKey: keyPair.publicKey, proof: body.proof,
          payload: { version: 1, accountId: 'alice', machineId: 'machine-1', installationId: 'install-1',
            rpcAdmission: { context: body.context,
              ...(body.purpose ? { purpose: body.purpose } : { method: body.method }) } } });
        return valid && granted ? { v: 1, ok: true } : reply.code(403).send({ error: 'access_denied' });
      });
      app.get(`/v2/sessions/${sessionId}`, async () => ({ session: createSessionRecordFixture({ id: sessionId,
        encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine-1' }), dataEncryptionKey: null, share: null }) }));
      app.get('/v1/account/saved-secrets/resources/materials', async () => SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
        resourceId: 'bob-profile-secret', encryptionMode: 'plain', recipientEnvelope: null,
        entry: { ref: reference, source: 'shared_resource', relationship: 'recipient', name: 'Bob secret', kind: 'apiKey',
          ownerAccountId: 'bob', revision: 1, materialStatus: 'ready',
          capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'bob-profile-secret', mode: 'plain',
          content: { v: 1, name: 'Bob secret', kind: 'apiKey', value: 'bob-profile-value' } }),
      }] }));
      await app.ready();
      const restore = installAxiosFastifyAdapter({ app, origin });
      const originalFetch = globalThis.fetch;
      // Only the Home HTTP transport is replaced; Profile, Saved Secret and installation admission owners stay real.
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        expect(url.origin).toBe(origin);
        const response = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
      });
      try {
        await createRequesterSessionCredentialCustody({ happyHomeDir: fixture.home, sessionId, attribution, credentials });
        const bootstrap = await resolveRequesterSessionBootstrap({ happyHomeDir: fixture.home, sessionId, attribution,
          serverHttpBaseUrl: origin, machineAdmissionBoundary: { machineId: 'machine-1', daemonToken: 'alice-daemon',
            isHomeCurrent: () => true, readInstallation: () => ({ installationId: 'install-1', privateKey: keyPair.secretKey }) } });
        expect(bootstrap).not.toBeNull();
        if (!bootstrap) throw new Error('Real Bob bootstrap unavailable');
        const alice = commitActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'alice-account-scope',
          settings: AccountSettingsSchema.parse({}), settingsVersion: 7, settingsSecretsReadKeys: [], loadedAtMs: 1 }).snapshot;
        const snapshot = bootstrap.savedSecretOperationContext.readSnapshot();
        if (!snapshot?.scopeKey) throw new Error('Real private Bob settings unavailable');
        expect(snapshot.profileCatalog).toBeUndefined();
        const dependencies: PrepareForegroundAgentRuntimeAdmissionDependencies = { requesterSessionBootstrap: bootstrap, connectedAccountsOwner: bobPurpose.owner,
          activateSessionPurposeBindings: bobPurpose.owner.activateSessionPurposeBindings,
          resolveExternalAgentSessionPurposeBindingSnapshot: async ({ authorizedPurposes, signal }) =>
            await bobPurpose.owner.resolveCurrentSessionPurposeBindingSnapshot({ authorizedPurposes, signal }),
          connectedServicesMaterializationBaseDir: join(fixture.home, 'bob-materialized') };
        const request = { ...agentRequest, sessionId, existingSessionId: sessionId, profileId: 'bob-profile', profileRecordRevision: 1,
          accountSettingsScopeKey: snapshot.scopeKey, accountSettingsVersion: snapshot.settingsVersion };
        const prepared = await fixture.prepare(request, dependencies);
        expect(prepared.ok, prepared.ok ? undefined : JSON.stringify(prepared.error)).toBe(true);
        if (!prepared.ok) throw new Error(`Bob foreground refused: ${prepared.error.code}`);
        expect(bootstrap.savedSecretOperationContext.readSnapshot()?.profileCatalog).toMatchObject({ status: 'ready', source: 'destination' });
        const claim = await prepared.prepared.claim({ canonicalSessionId: sessionId, httpPort: 43127,
          foregroundSatisfiedProfileSecretRequirementNames: [], nativeHomeSourceEnvironmentValue: aliceNativeHome });
        expect(claim, claim.ok ? undefined : JSON.stringify(claim)).toMatchObject({
          ok: true, environment: { BOB_PROFILE_SECRET: 'bob-profile-value' } });
        if (!claim.ok) throw new Error('Bob native Account claim refused');
        const nativeHome = claim.environment.ACME_NATIVE_HOME;
        if (!nativeHome) throw new Error('Bob isolated native Account home unavailable');
        expect(await readFile(join(nativeHome, 'auth.json'))).toEqual(Buffer.from([0, 255, 17, 99]));
        await expect(readFile(join(nativeHome, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(aliceNativeHome, 'config.toml'), 'utf8')).toBe('alice-private-config');
        expect(getActiveAccountSettingsSnapshot()).toBe(alice);
        expect(await fixture.prepare({ ...request, attemptId: 'stale-profile-selection', profileRecordRevision: 2 }, dependencies))
          .toMatchObject({ ok: false, error: { code: 'provider_agent_runtime_unsupported' } });
        const wrongTarget = await fixture.prepare({ ...request, attemptId: 'other-session-claim' }, dependencies);
        expect(wrongTarget.ok).toBe(true);
        if (!wrongTarget.ok) throw new Error('Current Bob foreground preparation failed');
        expect(await wrongTarget.prepared.claim({ canonicalSessionId: 'alice-session', httpPort: 43127,
          foregroundSatisfiedProfileSecretRequirementNames: [] })).toMatchObject({ ok: false });
        const pending = await fixture.prepare({ ...request, attemptId: 'lost-grant-attempt' }, dependencies);
        expect(pending.ok).toBe(true);
        if (!pending.ok) throw new Error('Current Bob foreground preparation failed');
        const homeFeatures = await fetchServerFeaturesSnapshot({ serverUrl: origin, token: credentials.token, projection: 'authenticated' });
        const trackedSessions = new Map<number, TrackedSession>();
        const runtime = await createRequesterSessionRuntimeContext({ bootstrap,
          activeServerDir: fixture.home, connectedServicesMaterializationBaseDir: join(fixture.home, 'bob-runtime-materialized'),
          resolveQualifiedConnectedAccountV4Support: () => resolveQualifiedConnectedAccountAtomicV4Negotiation(homeFeatures), coordinatorInput: {
            machineId: 'machine-1', machineIdProvider: () => 'machine-1', runtimeId: 'foreground-runtime', happyHomeDir: fixture.home,
            logger: { debug: () => {}, info: () => {}, warn: () => {} }, processEnv: {
              HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
            pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: new ConnectedServiceRuntimeRegistry(),
            connectedServiceAuthGroupPreTurnSwitchCoordinator: undefined,
          } });
        if (!runtime) throw new Error('Real requester runtime unavailable');
        try {
        const tracked: TrackedSession = { pid: fixture.foregroundPid, happySessionId: sessionId,
          startedBy: 'happy directly - likely by user from terminal',
          processStartTimeMs: claim.authority.runner.processStartTimeMs,
          processCommandHash: claim.authority.runner.processCommandHash };
        trackedSessions.set(tracked.pid, tracked);
        await writeSessionMarker({ pid: tracked.pid, happySessionId: sessionId, startedBy: 'terminal',
          processStartTimeMs: tracked.processStartTimeMs, processCommandHash: tracked.processCommandHash });
        const promotion = { happyHomeDir: fixture.home, publicReleaseRing: configuration.publicReleaseRing,
          trackedSessions, canonicalSessionId: sessionId, foregroundPid: fixture.foregroundPid,
          authorityFilePath: prepared.prepared.authorization.authorityFilePath,
          retainedAgent: claim.authority.retainedAgent, runner: claim.authority.runner,
          capabilityDigest: claim.authority.capabilityDigest, invocationContext: claim.invocationContext,
          requesterSessionRuntimeContext: runtime };
        expect(await promoteForegroundDaemonServiceAuthority(promotion)).toBe(true);
        expect(tracked.requesterSessionRuntimeContext).toBe(runtime);
        expect(tracked.requesterWorkAttributionV1).toEqual(attribution);
        const promotedMarker = await readSessionMarkerForPid(tracked.pid);
        expect(promotedMarker).toMatchObject({ happySessionId: sessionId,
          agentRuntimeDaemonServiceAuthorityFilePath: promotion.authorityFilePath,
          requesterWorkAttributionV1: attribution });
        expect(promotedMarker).not.toHaveProperty('requesterSessionRuntimeContext');
        expect(JSON.stringify(promotedMarker)).not.toContain(credentials.token);
        expect(JSON.stringify(promotedMarker)).not.toContain(Buffer.from(keyPair.secretKey).toString('base64'));
        await runtime.dispose();
        expect(await bootstrap.isCurrent()).toBe(true);
        expect(await promoteForegroundDaemonServiceAuthority(promotion)).toBe(false);
        expect(await fixture.prepare({ ...request, attemptId: 'disposed-runtime' }, {
          ...dependencies, requesterSessionRuntimeContext: runtime,
        })).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
        granted = false;
        expect(await pending.prepared.claim({ canonicalSessionId: sessionId, httpPort: 43127,
          foregroundSatisfiedProfileSecretRequirementNames: [] })).toMatchObject({ ok: false });
        expect(await fixture.prepare({ ...request, attemptId: 'lost-grant-before-prepare' }, dependencies)).toMatchObject({ ok: false });
        expect(getActiveAccountSettingsSnapshot()).toBe(alice);
        for (const read of reads) {
          const path = new URL(read.path, origin).pathname;
          if (path === '/v1/machines/machine-1/admission/verify') {
            // This exact signed installation check is the custodian daemon's
            // boundary; all requester-private Home reads below belong to Bob.
            expect(read.bearer, path).toBe('Bearer alice-daemon');
          } else if (path === '/v1/features') {
            // The canonical public feature observation is intentionally
            // anonymous (serverFeaturesClient), not an Account disclosure.
            expect([undefined, `Bearer ${credentials.token}`], path).toContain(read.bearer);
          } else {
            expect(read.bearer, path).toBe(`Bearer ${credentials.token}`);
          }
        }
        } finally { await runtime.dispose(); }
      } finally { restore(); vi.stubGlobal('fetch', originalFetch); await app.close(); }
    });
  });
});
